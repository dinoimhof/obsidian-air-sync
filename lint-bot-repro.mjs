const { spawnSync } = process.getBuiltinModule("node:child_process");
const { createHash } = process.getBuiltinModule("node:crypto");
const {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = process.getBuiltinModule("node:fs");
const { createRequire } = process.getBuiltinModule("node:module");
const { tmpdir } = process.getBuiltinModule("node:os");
const { dirname, join, relative, resolve } = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");

import {
	UNSAFE_RULE_IDS,
	classifyLintBotContrast,
} from "./lint-bot-repro-classifier.mjs";

export const REPRO_TARGETS = [
	"src",
];
export const REPRO_ESLINT_ARGS = ["--format", "json", "--ignore-pattern", "**/*.test.ts", ...REPRO_TARGETS];

const DIRECT_RUNTIME_PACKAGES = [
	"obsidian",
	"fflate",
	"ignore",
	"js-md5",
	"node-diff3",
	"@protontech/drive-sdk",
	"@protontech/crypto",
	"@protontech/crypto/proxy/endpoint/api.ts",
	"@protontech/crypto/srp",
];
/**
 * The npm package a specifier belongs to, ignoring any subpath (scoped packages keep
 * their scope segment, e.g. "@protontech/crypto/srp" -> "@protontech/crypto").
 */
function packageOf(specifier) {
	const segments = specifier.split("/");
	return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

// obsidian is always external (never bundled into main.js), so it's excluded from the
// esbuild bundle-contents probe below; every other runtime package must ship in the
// production bundle. Deduped to one representative specifier per package: a package's
// exports map can remap a subpath to an arbitrarily different physical file (e.g.
// "@protontech/crypto/srp" -> ".../src/srp/index.ts"), so there is no reliable way to
// predict a subpath's on-disk path from the specifier alone — proving the package's
// FIRST specifier bundled real code already proves that package isn't externalized.
const BUNDLE_CHECKED_RUNTIME_PACKAGES = (() => {
	const byPackage = new Map();
	for (const name of DIRECT_RUNTIME_PACKAGES) {
		if (name === "obsidian") continue;
		// First occurrence wins — every package lists its bare specifier before any
		// subpath, and only the bare specifier's directory-prefix check is reliable.
		if (!byPackage.has(packageOf(name))) byPackage.set(packageOf(name), name);
	}
	return [...byPackage.values()];
})();
const TEST_RUNNER_PACKAGES = ["vitest"];
// Real, permanent tsconfig.json "paths" redirects to a project-owned ambient stub —
// distinct from the temporary untyped-fixture injection below, which simulates the
// community scanner seeing NO declarations at all. A permanently-stubbed package's
// own real declarations are unusable for type-checking (e.g. raw, uncompiled TS
// source with no .d.ts boundary), so every workspace redirects it to our stub,
// except when it's also being actively injected-untyped for that workspace's
// simulation (that takes precedence — see assertTypeResolution).
const PERMANENT_TYPE_STUBS = {
	"@protontech/crypto": "src/platform/protontech-crypto.d.ts",
	"@protontech/crypto/proxy/endpoint/api.ts": "src/platform/protontech-crypto.d.ts",
	"@protontech/crypto/srp": "src/platform/protontech-crypto.d.ts",
};
const ALL_RESOLUTION_PACKAGES = [...DIRECT_RUNTIME_PACKAGES, ...TEST_RUNNER_PACKAGES];
const COMMON_PROJECT_FILES = [
	"package.json",
	"eslint.config.mts",
	"tsconfig.json",
	"manifest.json",
];
const EFFECTIVE_CONFIG_SENTINEL = "src/fs/dropbox/auth.ts";
const UNTYPED_FIXTURE = "test-fixtures/lint-bot-repro/untyped-dependencies.d.ts";
const UNTYPED_VITEST_FIXTURE = "test-fixtures/lint-bot-repro/untyped-vitest.d.ts";

function hashFile(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashTree(root) {
	const hash = createHash("sha256");
	function visit(directory) {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			const absolutePath = join(directory, entry.name);
			const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
			if (entry.isSymbolicLink()) {
				throw new Error(`repro source copy must not contain symlinks: ${relativePath}`);
			}
			hash.update(relativePath);
			if (entry.isDirectory()) visit(absolutePath);
			else if (entry.isFile()) hash.update(readFileSync(absolutePath));
			else throw new Error(`unsupported source entry in repro copy: ${relativePath}`);
		}
	}
	visit(root);
	return hash.digest("hex");
}

function copyCommonProject(projectRoot, workspace) {
	for (const file of COMMON_PROJECT_FILES) {
		cpSync(join(projectRoot, file), join(workspace, file));
	}
	cpSync(join(projectRoot, "src"), join(workspace, "src"), { recursive: true });
	if (lstatSync(join(workspace, "src")).isSymbolicLink()) {
		throw new Error("repro source must be copied, not symlinked");
	}
	symlinkSync(join(projectRoot, "node_modules"), join(workspace, "node_modules"), "dir");
}

function injectUntypedBoundary(projectRoot, workspace, packageNames, fixture) {
	const fixtureDestination = join(workspace, fixture);
	mkdirSync(dirname(fixtureDestination), { recursive: true });
	cpSync(join(projectRoot, fixture), fixtureDestination);

	const tsconfigPath = join(workspace, "tsconfig.json");
	const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
	// Merge, don't wipe: a permanent stub redirect (PERMANENT_TYPE_STUBS) must survive
	// injection for any package not itself being simulated as untyped here.
	tsconfig.compilerOptions.paths = { ...tsconfig.compilerOptions.paths };
	for (const packageName of packageNames) {
		tsconfig.compilerOptions.paths[packageName] = [
			`./${fixture}`,
		];
	}
	writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, "\t")}\n`);
}

function workspaceDescriptor(workspace) {
	return {
		sourceHash: hashTree(join(workspace, "src")),
		configHash: hashFile(join(workspace, "eslint.config.mts")),
		manifestHash: hashFile(join(workspace, "manifest.json")),
		packageHash: hashFile(join(workspace, "package.json")),
		tsconfig: JSON.parse(readFileSync(join(workspace, "tsconfig.json"), "utf8")),
		targets: [...REPRO_TARGETS],
	};
}

function expectedInjectedTsconfig(normal, packageNames, fixture) {
	const expected = structuredClone(normal);
	expected.compilerOptions.paths = { ...expected.compilerOptions.paths };
	for (const packageName of packageNames) expected.compilerOptions.paths[packageName] = [`./${fixture}`];
	return expected;
}

function assertWorkspaceContract(normalWorkspace, runtimeWorkspace, vitestWorkspace) {
	const normal = workspaceDescriptor(normalWorkspace);
	const runtime = workspaceDescriptor(runtimeWorkspace);
	const vitest = workspaceDescriptor(vitestWorkspace);
	for (const key of ["sourceHash", "configHash", "manifestHash", "packageHash"]) {
		if (normal[key] !== runtime[key] || normal[key] !== vitest[key]) {
			throw new Error(`workspace mismatch outside type boundary: ${key}`);
		}
	}
	if (JSON.stringify(normal.targets) !== JSON.stringify(runtime.targets) || JSON.stringify(normal.targets) !== JSON.stringify(vitest.targets)) {
		throw new Error("workspace target lists differ");
	}

	if (JSON.stringify(runtime.tsconfig) !== JSON.stringify(expectedInjectedTsconfig(normal.tsconfig, DIRECT_RUNTIME_PACKAGES, UNTYPED_FIXTURE))) {
		throw new Error("runtime-untyped workspace may differ only by the five runtime dependency paths");
	}
	if (JSON.stringify(vitest.tsconfig) !== JSON.stringify(expectedInjectedTsconfig(normal.tsconfig, TEST_RUNNER_PACKAGES, UNTYPED_VITEST_FIXTURE))) {
		throw new Error("Vitest-untyped workspace may differ only by the Vitest dependency path");
	}
	if (!existsSync(join(runtimeWorkspace, UNTYPED_FIXTURE))) {
		throw new Error(`runtime-untyped workspace is missing ${UNTYPED_FIXTURE}`);
	}
	if (!existsSync(join(vitestWorkspace, UNTYPED_VITEST_FIXTURE))) {
		throw new Error(`Vitest-untyped workspace is missing ${UNTYPED_VITEST_FIXTURE}`);
	}

	return {
		sourceHash: normal.sourceHash,
		configHash: normal.configHash,
		targetCount: normal.targets.length,
	};
}

function resolveLocalEslintBinary(projectRoot) {
	const binaryPath = join(projectRoot, "node_modules", ".bin", "eslint");
	if (!existsSync(binaryPath)) {
		throw new Error(
			`project-local ESLint is missing at ${binaryPath}; run npm ci outside this offline gate, then retry (no download fallback is permitted)`,
		);
	}
	return binaryPath;
}

function severityOf(ruleSetting) {
	const severity = Array.isArray(ruleSetting) ? ruleSetting[0] : ruleSetting;
	if (severity === 2 || severity === "error") return "error";
	if (severity === 1 || severity === "warn") return "warn";
	return "off";
}

function loadLocalEslintApi(projectRoot) {
	try {
		const requireFromProject = createRequire(join(projectRoot, "package.json"));
		const eslintModule = requireFromProject("eslint");
		if (typeof eslintModule.ESLint !== "function") {
			throw new TypeError("the local eslint package does not export ESLint");
		}
		return eslintModule.ESLint;
	} catch (error) {
		throw new Error(
			`project-local ESLint API could not be loaded from ${join(projectRoot, "node_modules")}: ${error.message}`,
			{ cause: error },
		);
	}
}

function loadProjectPackage(projectRoot, packageName) {
	try {
		const requireFromProject = createRequire(join(projectRoot, "package.json"));
		return requireFromProject(packageName);
	} catch (error) {
		throw new Error(
			`project-local ${packageName} API could not be loaded from ${join(projectRoot, "node_modules")}: ${error.message}`,
			{ cause: error },
		);
	}
}

function assertTypeResolution(projectRoot, workspace, injectedPackages = [], fixture = null) {
	const ts = loadProjectPackage(projectRoot, "typescript");
	const configPath = join(workspace, "tsconfig.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) {
		throw new Error(`TypeScript could not read ${configPath}`);
	}
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, workspace);
	if (parsed.errors.length > 0) {
		throw new Error(`TypeScript could not parse ${configPath}`);
	}
	const resolutions = {};
	for (const packageName of ALL_RESOLUTION_PACKAGES) {
		const resolvedModule = ts.resolveModuleName(
			packageName,
			join(workspace, "src", "main.ts"),
			parsed.options,
			ts.sys,
		).resolvedModule;
		if (!resolvedModule) {
			throw new Error(`TypeScript did not resolve ${packageName} in the repro workspace`);
		}
		const actualPath = resolve(resolvedModule.resolvedFileName);
		if (injectedPackages.includes(packageName)) {
			const expectedPath = resolve(join(workspace, fixture));
			if (actualPath !== expectedPath) {
				throw new Error(
					`TypeScript resolved ${packageName} to ${actualPath}; expected pre-fix fixture ${expectedPath}`,
				);
			}
		} else if (packageName in PERMANENT_TYPE_STUBS) {
			const expectedPath = resolve(join(workspace, PERMANENT_TYPE_STUBS[packageName]));
			if (actualPath !== expectedPath) {
				throw new Error(
					`TypeScript resolved ${packageName} to ${actualPath}; expected the permanent ambient stub ${expectedPath}`,
				);
			}
		} else if (!actualPath.includes(`/node_modules/${packageName}/`)) {
			throw new Error(
				`TypeScript resolved ${packageName} to ${actualPath}; expected installed dependency declarations`,
			);
		}
		resolutions[packageName] = relative(workspace, actualPath).replaceAll("\\", "/");
	}
	return resolutions;
}

async function assertRuntimeBundleResolution(projectRoot) {
	const esbuild = loadProjectPackage(projectRoot, "esbuild");
	const result = await esbuild.build({
		stdin: {
			contents: [
				'import * as fflate from "fflate";',
				'import ignore from "ignore";',
				'import md5 from "js-md5";',
				'import * as diff3 from "node-diff3";',
				'import { VERSION as protonDriveSdkVersion } from "@protontech/drive-sdk";',
				'import { CryptoProxy } from "@protontech/crypto";',
				'import { Api as protonCryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";',
				'import { generateKeySalt as protonCryptoGenerateKeySalt } from "@protontech/crypto/srp";',
				"globalThis.__airSyncRuntimeResolution = [fflate, ignore, md5, diff3, protonDriveSdkVersion, CryptoProxy, protonCryptoApi, protonCryptoGenerateKeySalt];",
			].join("\n"),
			loader: "ts",
			resolveDir: projectRoot,
			sourcefile: "runtime-resolution.ts",
		},
		bundle: true,
		format: "esm",
		metafile: true,
		platform: "browser",
		tsconfig: join(projectRoot, "tsconfig.json"),
		write: false,
	});
	const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
	for (const packageName of BUNDLE_CHECKED_RUNTIME_PACKAGES) {
		if (!inputs.some((input) => input.includes(`node_modules/${packageName}/`))) {
			throw new Error(`esbuild bundle does not contain the runtime implementation for ${packageName}`);
		}
	}
	return inputs.filter((input) => input.includes("node_modules/"));
}

async function assertEffectiveConfig(projectRoot, ...workspaces) {
	const ESLint = loadLocalEslintApi(projectRoot);
	const configurations = [];
	for (const workspace of workspaces) {
		const eslint = new ESLint({
			cwd: workspace,
			overrideConfigFile: join(workspace, "eslint.config.mts"),
		});
		const config = await eslint.calculateConfigForFile(join(workspace, EFFECTIVE_CONFIG_SENTINEL));
		if (!config) {
			throw new Error(`ESLint returned no effective config for ${EFFECTIVE_CONFIG_SENTINEL}`);
		}
		const ruleSettings = Object.fromEntries(
			UNSAFE_RULE_IDS.map((ruleId) => [ruleId, config.rules?.[ruleId]]),
		);
		for (const [ruleId, setting] of Object.entries(ruleSettings)) {
			if (severityOf(setting) !== "error") {
				throw new Error(
					`effective config must keep ${ruleId} at error for ${EFFECTIVE_CONFIG_SENTINEL}`,
				);
			}
		}
		configurations.push(ruleSettings);
	}
	if (configurations.slice(1).some((configuration) => JSON.stringify(configuration) !== JSON.stringify(configurations[0]))) {
		throw new Error("workspace effective configs differ for the five unsafe rules");
	}
}

function runEslint(binaryPath, workspace, spawn) {
	const result = spawn(binaryPath, REPRO_ESLINT_ARGS, {
		cwd: workspace,
		encoding: "utf8",
		env: { ...process.env, ESLINT_USE_FLAT_CONFIG: "true" },
	});
	if (result.error) {
		throw new Error(`failed to start project-local ESLint at ${binaryPath}: ${result.error.message}`);
	}
	if (typeof result.stdout !== "string") {
		throw new Error(`project-local ESLint at ${binaryPath} returned no JSON stdout`);
	}
	if (result.status !== 0 && result.status !== 1 && result.stderr) {
		throw new Error(
			`project-local ESLint failed as a tool (exit ${String(result.status)}): ${result.stderr.trim()}`,
		);
	}
	return { exitStatus: result.status, eslintJson: result.stdout };
}

export async function runLintBotReproduction({
	projectRoot = process.cwd(),
	spawn = spawnSync,
	verifyEffectiveConfig = assertEffectiveConfig,
	verifyResolution = assertTypeResolution,
	verifyRuntimeBundle = assertRuntimeBundleResolution,
	onWorkspaceCreated = () => {},
	onLintResults = () => {},
} = {}) {
	const tempRoot = mkdtempSync(join(tmpdir(), "airsync-bot-lint-"));
	onWorkspaceCreated(tempRoot);
	try {
		const binaryPath = resolveLocalEslintBinary(projectRoot);
		const runtimeBundleInputs = await verifyRuntimeBundle(projectRoot);
		const normalWorkspace = join(tempRoot, "normal");
		const runtimeWorkspace = join(tempRoot, "runtime-untyped");
		const vitestWorkspace = join(tempRoot, "vitest-untyped");
		mkdirSync(normalWorkspace);
		mkdirSync(runtimeWorkspace);
		mkdirSync(vitestWorkspace);
		copyCommonProject(projectRoot, normalWorkspace);
		copyCommonProject(projectRoot, runtimeWorkspace);
		copyCommonProject(projectRoot, vitestWorkspace);
		injectUntypedBoundary(projectRoot, runtimeWorkspace, DIRECT_RUNTIME_PACKAGES, UNTYPED_FIXTURE);
		injectUntypedBoundary(projectRoot, vitestWorkspace, TEST_RUNNER_PACKAGES, UNTYPED_VITEST_FIXTURE);
		const descriptor = assertWorkspaceContract(normalWorkspace, runtimeWorkspace, vitestWorkspace);
		const normalResolutions = verifyResolution(projectRoot, normalWorkspace);
		const runtimeResolutions = verifyResolution(projectRoot, runtimeWorkspace, DIRECT_RUNTIME_PACKAGES, UNTYPED_FIXTURE);
		const vitestResolutions = verifyResolution(projectRoot, vitestWorkspace, TEST_RUNNER_PACKAGES, UNTYPED_VITEST_FIXTURE);
		await verifyEffectiveConfig(projectRoot, normalWorkspace, runtimeWorkspace, vitestWorkspace);

		const normal = runEslint(binaryPath, normalWorkspace, spawn);
		const runtimeUntyped = runEslint(binaryPath, runtimeWorkspace, spawn);
		const vitestUntyped = runEslint(binaryPath, vitestWorkspace, spawn);
		onLintResults({ normal, runtimeUntyped, vitestUntyped });
		const classification = classifyLintBotContrast({ normal, runtimeUntyped, vitestUntyped });
		if (!classification.ok) {
			throw new Error(`${classification.code}: ${classification.message}`);
		}
		return {
			classification,
			descriptor,
			normalResolutions,
			runtimeResolutions,
			vitestResolutions,
			runtimeBundleInputs,
		};
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = await runLintBotReproduction();
		const runtimeInjected = DIRECT_RUNTIME_PACKAGES.length;
		const vitestInjected = TEST_RUNNER_PACKAGES.length;
		const bundleChecked = BUNDLE_CHECKED_RUNTIME_PACKAGES.length;
		process.stdout.write(
			`${result.classification.message}; TypeScript resolved ${runtimeInjected}/${runtimeInjected} runtime and ${vitestInjected}/${vitestInjected} Vitest injections to isolated fixtures; esbuild bundled ${bundleChecked}/${bundleChecked} runtime implementations; source/config hashes matched\n`,
		);
	} catch (error) {
		process.stderr.write(`lint-bot repro failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
