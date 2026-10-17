/**
 * Whether a decrypted Proton node name can become one segment of a vault path. The SDK
 * only checks that a name is non-empty and short enough; a name another client wrote can
 * still be `..`, contain a separator, or carry control characters that break paths or
 * forge log lines. Such a node is treated like one whose name did not decrypt.
 */
export function isSafeNodeName(name: string): boolean {
	if (name === "" || name === "." || name === "..") return false;
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		// C0 controls (NUL included), DEL, "/" and "\".
		if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) return false;
	}
	return true;
}
