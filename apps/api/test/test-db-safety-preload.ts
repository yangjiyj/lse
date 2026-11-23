// Load the environment safety gate before Node schedules the parallel test files.
// This prevents a test run pointed at the deployed database from mutating live data.
//
// 这是测试专用入口：必须显式设置 LSE_TEST=1。src/env.ts 只有在 LSE_TEST=1 时才校验库地址，
// 漏设时闸门被整个跳过（见 assertTestEntryEnvironment 的说明）。设了之后，库地址白名单照常生效。
import { assertTestEntryEnvironment } from '../src/test-db-safety.js';

assertTestEntryEnvironment(process.env);

await import('../src/env.js');
