// macOS renderer-accessibility crash suppressor for CardMirror.
//
// Electron 42 / Chromium 148 has a deterministic renderer crash in Blink's
// accessibility serialization (blink::AXBlockFlowData::ComputeNeighborOnLine,
// a CHECK in the AXBlockFlowIterator line-navigation code) that fires whenever
// the web accessibility tree is built. On macOS the tree is switched on when an
// assistive-tech client sets the AXEnhancedUserInterface / AXManualAccessibility
// attribute on the shared NSApplication — a path the
// `--disable-renderer-accessibility` Chromium switch does NOT intercept.
//
// This library swizzles -[NSApplication accessibilitySetValue:forAttribute:] on
// the concrete application class so those two attributes are dropped instead of
// forwarded, keeping Chromium accessibility from ever turning on. Every other
// attribute passes through to the original implementation unchanged.
//
// The replacement is plain compiled C: AppKit invokes it directly, with no
// crossing back into JavaScript/V8. (A koffi.register JS callback cannot be used
// here — AppKit invoking a JS trampoline mid-runloop aborts under V8's
// control-flow-integrity check.) koffi loads this dylib and calls cm_suppress_ax()
// exactly once at startup; the outbound call returns immediately and koffi plays
// no part in the AppKit dispatch that follows.
//
// cm_suppress_ax() returns 1 on success, 0 if the method could not be resolved.
// Idempotent — safe to call more than once.

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <objc/message.h>

typedef void (*AxSetImp)(id, SEL, id, id);

static AxSetImp g_original = NULL;
static int g_installed = 0;
static int g_dropped = 0;

// The two attributes that switch the Chromium accessibility tree on. Dropping
// only these (rather than no-op'ing the whole method) keeps the blast radius
// minimal — unrelated AX attribute writes still reach AppKit normally.
static BOOL cm_is_tree_attribute(id attribute) {
  if (![attribute isKindOfClass:[NSString class]]) return NO;
  NSString *name = (NSString *)attribute;
  return [name isEqualToString:@"AXEnhancedUserInterface"] ||
         [name isEqualToString:@"AXManualAccessibility"];
}

static void cm_ax_set_value(id self, SEL _cmd, id value, id attribute) {
  if (cm_is_tree_attribute(attribute)) {
    g_dropped++;
    return;
  }
  if (g_original) g_original(self, _cmd, value, attribute);
}

// Number of accessibility-tree activations dropped since load. Diagnostic: lets
// the mechanism be verified directly (the swizzle fired and dropped an
// activation) rather than inferred from a downstream flag. Exported for a test
// harness / future telemetry; not read on the normal startup path.
__attribute__((visibility("default")))
int cm_dropped_count(void) {
  return g_dropped;
}

__attribute__((visibility("default")))
int cm_suppress_ax(void) {
  if (g_installed) return 1;

  NSApplication *appInst = [NSApplication sharedApplication];
  if (appInst == nil) return 0;
  // The concrete class — Electron's NSApplication subclass — not NSApplication
  // itself, so an override on the subclass is the one we replace.
  Class cls = object_getClass(appInst);
  if (cls == nil) return 0;

  SEL sel = sel_registerName("accessibilitySetValue:forAttribute:");
  Method m = class_getInstanceMethod(cls, sel);
  if (m == NULL) return 0;

  g_original = (AxSetImp)method_getImplementation(m);

  // Install our IMP as an override on the concrete class only. If the method is
  // inherited, class_addMethod adds the override (g_original keeps the inherited
  // IMP for passthrough); if the class already defines it, swap the IMP in place.
  // Either way the change is scoped to this one class, not NSResponder at large.
  if (!class_addMethod(cls, sel, (IMP)cm_ax_set_value, method_getTypeEncoding(m))) {
    method_setImplementation(class_getInstanceMethod(cls, sel), (IMP)cm_ax_set_value);
  }

  g_installed = 1;
  return 1;
}
