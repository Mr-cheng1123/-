# GitHub Copilot — Why Claude Models Show "Upgrade" on Pro / Pro+

## 问题描述 / Problem

即使已经订阅了 GitHub Copilot **Pro** 或 **Pro+**，在 VS Code 的 Copilot Chat 模型选择器里，Claude 系列模型（如 Claude Sonnet 4.6、Claude Opus 4.6）旁边仍然显示 **"升级"（Upgrade）** 标记，无法直接选用。

Even with an active **Copilot Pro** or **Pro+** subscription, Claude models (e.g. Claude Sonnet 4.6, Claude Opus 4.6) may appear locked with an **"Upgrade"** badge in the VS Code Copilot Chat model picker.

---

## 已知原因 / Known Causes

### 1. 组织/企业策略限制（最常见）Organization or Enterprise Policy Restriction *(most common)*

如果你的 GitHub 账号同时归属于某个 **组织（Organization）** 或 **企业（Enterprise）**，该组织的管理员可以：

- 限制成员只能使用特定模型
- 禁用 Claude 等第三方模型
- 覆盖个人 Pro/Pro+ 订阅的模型权限

**如何确认：**

1. 打开 <https://github.com/settings/copilot>
2. 检查你的 Copilot 订阅是否显示为"由组织提供（Provided by organization）"
3. 如果是，联系该组织的 GitHub 管理员，请其在 **Organization Settings → Copilot → Policies** 中启用 Claude 模型

---

### 2. 个人订阅 vs 组织席位冲突 Personal vs Organization Seat Conflict

当一个账号同时拥有**个人 Pro/Pro+ 订阅**和**组织分配的席位**时，组织席位优先生效。此时个人订阅的模型权限可能被组织策略覆盖。

**如何确认：**

- 访问 <https://github.com/settings/billing/summary> 查看当前生效的订阅来源
- 若显示组织托管，联系管理员开放 Claude 权限

---

### 3. 订阅激活延迟 Subscription Activation Delay

刚升级到 Pro+ 后，部分高级模型的访问权限有时需要几分钟至数小时才能完全同步。

**解决步骤：**

1. 退出 VS Code 并重新登录 GitHub 账号
2. 重启 VS Code 或执行 **Reload Window**
3. 重新打开 Copilot Chat 模型选择器

---

### 4. 高级请求配额耗尽 Premium Request Quota Exhausted

| 套餐 | 每月高级请求数 |
|------|--------------|
| Copilot Pro | 300 次 |
| Copilot Pro+ | 1,500 次 |
| Copilot Business | 1,000 次 |
| Copilot Enterprise | 1,500 次 |

当月高级请求耗尽后，Claude、GPT-4.x 等高级模型会被锁定，直到下个计费周期重置。

**如何确认：**

- 访问 <https://github.com/settings/copilot> 查看剩余配额
- 如需更多请求量，可在结算页面按需购买额外配额

---

### 5. 模型逐步灰度发布 Gradual Feature Rollout

GitHub 有时会对新模型（如最新版 Claude）进行**灰度发布**，部分账号可能暂时看不到某些模型，即使套餐理论上支持。

**建议：**

- 确保 VS Code 和 GitHub Copilot 扩展都升级到最新版本
- 等待 1–2 天后重试
- 查看 [GitHub Changelog](https://github.blog/changelog/) 了解模型发布状态

---

### 6. Pro 与 Pro+ 的模型访问差异 Pro vs Pro+ Model Access Differences

| 模型 | Copilot Pro | Copilot Pro+ |
|------|------------|--------------|
| Claude Sonnet 4.5 | ✅ 可用 | ✅ 可用 |
| Claude Opus 4.6 | ❌ 不可用 | ✅ 可用 |
| GPT-5.4 / GPT-5.x | ✅ 部分 | ✅ 全部 |
| 每月高级请求 | 300 次 | 1,500 次 |
| 优先获取新模型 | ❌ | ✅ |

如果你是 **Pro（非 Pro+）** 用户，Claude Opus 4.6 等更高级的 Claude 模型确实需要升级至 **Pro+**。

---

## 排查步骤汇总 / Troubleshooting Checklist

```
1. 确认订阅来源
   → https://github.com/settings/copilot
   → 是个人订阅还是组织分配？

2. 检查剩余配额
   → 同上页面，查看"Premium requests"剩余数量

3. 确认套餐等级
   → Pro 用户能用 Claude Sonnet；Claude Opus 需 Pro+

4. 组织账号 → 联系管理员
   → Organization Settings → Copilot → Policies → 启用 Claude

5. 更新工具
   → 升级 VS Code 及 GitHub Copilot 扩展至最新版

6. 重新登录
   → VS Code 中退出并重新登录 GitHub 账号

7. 联系支持
   → https://support.github.com（选择 Copilot 类别）
```

---

## 参考链接 / References

- [GitHub Copilot Plans & Pricing](https://github.com/features/copilot/plans)
- [Plans for GitHub Copilot — Official Docs](https://docs.github.com/en/copilot/get-started/plans)
- [Supported AI Models in GitHub Copilot](https://docs.github.com/copilot/using-github-copilot/using-claude-sonnet-in-github-copilot)
- [Viewing and Changing Your Copilot Plan](https://docs.github.com/en/copilot/how-tos/manage-your-account/view-and-change-your-copilot-plan)
- [VS Code Copilot FAQ](https://code.visualstudio.com/docs/copilot/faq)
- [AI Language Models in VS Code](https://code.visualstudio.com/docs/copilot/customization/language-models)
- [GitHub Copilot Community Discussion: Pro+ Premium Models Blocked](https://github.com/orgs/community/discussions/161595)
