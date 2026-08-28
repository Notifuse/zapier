// Keeps the CI Node pin, this repo's engines.node and the Node the Zapier CLI actually
// demands from drifting apart.
//
// They already had. zapier-platform-cli advertises `engines.node: ">=18.20"` in its own
// package.json, but its oclif init hook refuses to start below Node 22, so a workflow that
// trusted the advertised floor died on `zapier-platform validate` — the last step of CI —
// on every single push. A workflow that is red for its own reasons carries no signal, and
// this one exists to carry the payload-drift diff.
//
// So the pin is not checked against a number written down twice. It is checked against the
// CLI installed in node_modules: the floor it enforces, and the Node major Zapier executes
// integrations on. When a CLI upgrade moves either, this step says so.

const { readFileSync } = require('node:fs');
const path = require('node:path');

const CLI_CONSTANTS = 'zapier-platform-cli/src/constants';
const repoRoot = path.resolve(__dirname, '..');
const problems = [];

// Reads the leading major out of a range like ">=22" or ">= 22.1.0". Deliberately not semver:
// semver is only present here as a hoisted transitive dependency, and a guard that breaks when
// the tree is deduped differently is worse than no guard.
const floorMajor = (range) => {
  const match = /^\s*>=\s*(\d+)/.exec(String(range));
  return match ? Number(match[1]) : null;
};

let cli;
try {
  cli = require(CLI_CONSTANTS);
} catch (err) {
  console.error(
    `Cannot load ${CLI_CONSTANTS}: ${err.message}\n` +
      'The CLI reorganised its internals. Re-point this guard at wherever it now declares ' +
      'NODE_VERSION (the Node major Zapier runs integrations on) and NODE_VERSION_CLI_REQUIRES ' +
      '(the floor the CLI enforces at startup).',
  );
  process.exit(1);
}

const runtimeMajor = Number(cli.NODE_VERSION);
const cliFloor = floorMajor(cli.NODE_VERSION_CLI_REQUIRES);
const runnerMajor = Number(process.versions.node.split('.')[0]);

if (!Number.isInteger(runtimeMajor) || cliFloor === null) {
  console.error(
    `${CLI_CONSTANTS} no longer declares a Node major and a ">=N" floor ` +
      `(got NODE_VERSION=${cli.NODE_VERSION}, NODE_VERSION_CLI_REQUIRES=${cli.NODE_VERSION_CLI_REQUIRES}). ` +
      'Update this guard to read them from wherever they moved.',
  );
  process.exit(1);
}

// Exact, not ">=". A newer Node clears the CLI floor and looks fine here while hiding anything
// that behaves differently on the major Zapier will actually execute this integration on.
if (runnerMajor !== runtimeMajor) {
  problems.push(
    `This job runs Node ${runnerMajor}, but Zapier executes integrations on Node ${runtimeMajor}. ` +
      `Set node-version in .github/workflows/ci.yml to '${runtimeMajor}'.`,
  );
}

if (runnerMajor < cliFloor) {
  problems.push(
    `zapier-platform-cli refuses to start below Node ${cliFloor} and this job runs Node ${runnerMajor}, ` +
      'so every command that reaches the CLI will exit non-zero. ' +
      "Do not trust the CLI's own engines.node — it still advertises a floor its startup hook rejects.",
  );
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const declaredFloor = floorMajor(pkg.engines && pkg.engines.node);

if (declaredFloor === null) {
  problems.push(
    `package.json engines.node is ${JSON.stringify(pkg.engines && pkg.engines.node)}; ` +
      'it must be a ">=N" range so this guard can compare it with what the CLI enforces.',
  );
} else if (declaredFloor !== cliFloor) {
  problems.push(
    `package.json declares engines.node ">=${declaredFloor}" but zapier-platform-cli enforces ` +
      `">=${cliFloor}". Anyone installing on ${declaredFloor} gets a tree that cannot run validate.`,
  );
}

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}

console.log(
  `Node ${runnerMajor} matches the Zapier runtime (${runtimeMajor}) and clears the CLI floor (>=${cliFloor}).`,
);
