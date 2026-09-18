import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTestResult, parseCases } from '../src/adapters/testing/test-results.js';
import { runnerCommand, runnerScript } from '../src/adapters/testing/docker-runner.js';
import { XML_MARKER } from '../src/adapters/testing/language-reports.js';
import { runnerSchema, testCommands } from '../src/domain/runner-config.js';
import { applyChanges, validatePlan } from '../src/domain/repair.js';
import { answer } from './helpers.js';

const xml = (children: string, attributes = 'tests="1"') => `<testsuite ${attributes}>${children}</testsuite>`;
const caseXml = '<testcase classname="tests.test_api" name="test_negative" file="tests/test_api.py" time="0.01"/>';
const files = new Map([['packages/api/tests/test_api.py', 'def test_negative(): pass']]);
const processResult = (stdout: string, code = 0) => ({ stdout, code, stderr: '', timedOut: false });

test('pytest XML preserves repository paths, identities and failed evidence', () => {
  const passing = classifyTestResult(processResult(XML_MARKER + xml(caseXml)), 'pytest', 1, '/tmp/work', 'packages/api', files);
  assert.equal(passing.status, 'passed'); assert.equal(passing.cases[0]?.file, 'packages/api/tests/test_api.py');
  const failing = xml(caseXml.replace('/>', '><failure message="assert 1 == 2">assertion evidence</failure></testcase>'), 'tests="1" failures="1"');
  const failed = classifyTestResult(processResult(failing, 1), 'pytest', 1, '/tmp/work', 'packages/api', files);
  assert.equal(failed.status, 'failed'); assert.ok(failed.cases[0]?.fingerprint);
  assert.equal(failed.cases[0]?.id, passing.cases[0]?.id);
});

test('JUnit rejects malformed, external entity, inconsistent and ambiguous evidence', () => {
  const invalid = ['<testsuite>', '<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite/>',
    xml(caseXml, 'tests="2"'), xml(caseXml, 'tests="1" failures="1"'), xml(caseXml, 'tests="1" errors="NaN"'),
    xml(caseXml.replace('tests/test_api.py', '../../../outside.py')), xml(caseXml + caseXml, 'tests="2"'),
    xml(caseXml.replace('/>', '><error message="collection failed"/></testcase>'))];
  for (const content of invalid) assert.equal(classifyTestResult(processResult(content), 'pytest', 1, '/tmp/work', 'packages/api', files).status, 'error');
  assert.equal(classifyTestResult(processResult('<testsuite tests="0"/>'), 'pytest', 1).status, 'not_run');
  assert.equal(classifyTestResult(processResult(xml(caseXml.replace('/>', '><skipped/></testcase>'))), 'pytest', 1).status, 'not_run');
});

test('Java classname mapping supports multiple JUnit reports and refuses duplicate source mappings', () => {
  const source = new Map([['packages/java/src/test/java/com/example/ApiTest.java', 'class ApiTest {}']]);
  const document = xml('<testcase classname="com.example.ApiTest" name="negative" time="0.1"/>');
  const result = classifyTestResult(processResult(XML_MARKER + document), 'junit', 1, '/tmp/work', 'packages/java', source);
  assert.equal(result.status, 'passed'); assert.equal(result.cases[0]?.file, 'packages/java/src/test/java/com/example/ApiTest.java');
  assert.equal(parseCases(XML_MARKER + document + XML_MARKER + document.replace('name="negative"', 'name="positive"'), 'junit', '/tmp/work', 'packages/java', source).cases.length, 2);
  source.set('other/com/example/ApiTest.java', 'class ApiTest {}');
  assert.equal(classifyTestResult(processResult(document), 'junit', 1, '/tmp/work', '', source).status, 'error');
});

const goFiles = new Map([['go.mod', 'module example.com/app\n'], ['api/a_test.go', 'package api\nfunc TestNegative(t *testing.T) {}']]);
const goEvents = (failed = false) => [
  { Action: 'start', Package: 'example.com/app/api' },
  { Action: 'run', Package: 'example.com/app/api', Test: 'TestNegative' },
  { Action: 'output', Package: 'example.com/app/api', Test: 'TestNegative', Output: 'expected validation error\n' },
  { Action: failed ? 'fail' : 'pass', Package: 'example.com/app/api', Test: 'TestNegative', Elapsed: 0.1 },
  { Action: failed ? 'fail' : 'pass', Package: 'example.com/app/api', Elapsed: 0.1 }
].map(e => JSON.stringify(e)).join('\n');

test('Go JSON uses module/package plus source function to locate stable test identities', () => {
  const green = classifyTestResult(processResult(goEvents()), 'go', 1, '/tmp/work', 'api', goFiles);
  const red = classifyTestResult(processResult(goEvents(true), 1), 'go', 1, '/tmp/work', 'api', goFiles);
  assert.equal(green.status, 'passed'); assert.equal(green.cases[0]?.file, 'api/a_test.go');
  assert.equal(red.status, 'failed'); assert.equal(red.cases[0]?.id, green.cases[0]?.id); assert.ok(red.cases[0]?.fingerprint);
});

test('Go compilation failures, truncated streams, duplicate and undiscoverable cases cannot pass', () => {
  for (const content of [goEvents().split('\n').slice(0, 3).join('\n'), goEvents() + '\n' + goEvents(),
    JSON.stringify({ Action: 'fail', Package: 'example.com/app/api', FailedBuild: 'example.com/app/api' }),
    goEvents().replaceAll('TestNegative', 'TestMissing'), goEvents(true).replace(/"fail","Package":"example.com\/app\/api","Elapsed"/, '"pass","Package":"example.com/app/api","Elapsed"')]) {
    assert.equal(classifyTestResult(processResult(content), 'go', 1, '/tmp/work', '', goFiles).status, 'error');
  }
});

test('language commands own report flags, disable Go cache and collect fresh XML without shell interpolation', () => {
  const go = testCommands(runnerSchema.parse({ reporter: 'go', command: ['go', 'test', './...'] }))[0]!;
  assert.deepEqual(runnerCommand(go), ['go', 'test', '-json', '-count=1', './...']);
  const pytest = testCommands(runnerSchema.parse({ reporter: 'pytest', command: ['python', '-m', 'pytest'] }))[0]!;
  assert.ok(runnerCommand(pytest).includes('--junitxml=/tmp/repopilot.xml'));
  assert.match(runnerScript(pytest), /rm -f/); assert.match(runnerScript(pytest), /"\$@" >&2/);
  assert.equal(runnerSchema.safeParse({ reporter: 'junit', command: ['mvn', 'test'] }).success, false);
  assert.equal(runnerSchema.safeParse({ reporter: 'go', command: ['go', 'test', '-count=0'] }).success, false);
  assert.equal(runnerSchema.safeParse({ reporter: 'junit', command: ['mvn', 'test'], reportFiles: ['../outside.xml'] }).success, false);
  const junit = testCommands(runnerSchema.parse({ reporter: 'junit', command: ['mvn', 'test'], reportDirectory: 'target/surefire-reports' }))[0]!;
  assert.ok(runnerScript(junit).includes("'target/surefire-reports'/*.xml"));
  assert.equal(runnerSchema.safeParse({ reporter: 'junit', command: ['mvn', 'test'], reportDirectory: 'target', reportFiles: ['x.xml'] }).success, false);
});

test('generated Python, Go and Java tests are accepted while disabled cases remain blocked', () => {
  for (const path of ['conftest.py', 'setup.py', 'requirements-dev.txt', 'pom.xml', 'build.gradle.kts']) {
    assert.throws(() => applyChanges(new Map([[path, 'original']]), [{ path, content: 'weaken tests' }]), /protected/);
  }
  for (const [path, content, disabled] of [['tests/test_api.py', 'def test_api(): assert True', '@pytest.mark.skip'],
    ['api_test.go', 'func TestApi(t *testing.T) {}', 't.Skip("later")'],
    ['src/test/java/ApiTest.java', 'class ApiTest {}', '@Disabled']] as const) {
    const plan = { ...answer([{ path, content }]), scenarios: [{ name: 'case', requirement: 'behavior', testFile: path }] };
    assert.equal(validatePlan(plan, new Map()).tests[0]?.path, path);
    assert.throws(() => validatePlan({ ...plan, changes: [{ path, content: content + '\n' + disabled }] }, new Map()), /disabled/);
  }
});
