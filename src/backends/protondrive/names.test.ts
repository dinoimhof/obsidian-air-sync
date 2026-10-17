import { describe, expect, it } from "vitest";
import { isSafeNodeName } from "./names";

describe("isSafeNodeName", () => {
	it("rejects names that cannot be one path segment", () => {
		for (const name of ["", ".", "..", "a/b", "a\\b", "nul\u0000", "tab\t", "new\nline", "del\u007f"]) {
			expect(isSafeNodeName(name)).toBe(false);
		}
	});

	it("accepts ordinary names, including leading dots and unicode", () => {
		for (const name of ["note.md", ".hidden", "...", "Ünïcödé 📝", "a..b", "name with spaces"]) {
			expect(isSafeNodeName(name)).toBe(true);
		}
	});
});
