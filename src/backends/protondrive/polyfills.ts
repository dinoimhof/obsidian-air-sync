// Built-ins the SDK and its crypto package call that older Android WebViews lack, or that
// some Electron builds expose without implementing them (`Uint8Array.prototype.toHex`
// present but not callable was seen live). core-js checks each one by calling it, and
// replaces it only when it is missing or misbehaves. This module must stay the first import
// of sdk-client.ts, so it runs before any @protontech module evaluates.
// Probe and drop broken hex/base64 built-ins first, so core-js below replaces them too.
import "./broken-builtins";
import "core-js/proposals/array-buffer-base64";
import "core-js/actual/array/from-async";
import "core-js/actual/iterator";
import "core-js/actual/promise/with-resolvers";
