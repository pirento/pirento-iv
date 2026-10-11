import { defineConfig, devices } from '@playwright/test';
import { loadEnvironmentValues } from './src/config/environment.js';

const environment = loadEnvironmentValues({ environment: { ...process.env } });
if (environment.MONGODB_TEST_URI) process.env.MONGODB_TEST_URI = environment.MONGODB_TEST_URI;
const executablePath = environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-summary.json' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
