import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 前端用例（test/client.test.js）是 jsdom + 整棵 React 树重建，且大量使用 waitForText
    // 这类 5ms 步进的轮询等待。默认并行（24 个测试文件）在机器负载高时，单个用例的**墙钟**
    // 时间可能被拖过 vitest 的 5s 默认超时而被误判失败（实测：同一用例单独跑 ~50ms，
    // 满负载下偶发 >5s；串行 / --maxWorkers=2 必过）。
    //
    // package.json 的 ci 脚本本来就带 --testTimeout=20000 --retry=2，这里让 npm test 与 ci
    // 同一口径：超时放宽，但**不加 retry**（重试会掩盖真实失败，放宽超时不会）。
    testTimeout: 20000,
  },
})
