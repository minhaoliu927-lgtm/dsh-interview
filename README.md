<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-white.svg">
    <img src="assets/brand/logo-black.svg" alt="职镜AI · dsh-interview" width="330" height="96">
  </picture>
</p>

<h1 align="center">dsh-interview</h1>
<p align="center">在 DSH 里改简历、准备岗位、练习面试。</p>
<p align="center">
  <a href="https://github.com/minhaoliu927-lgtm/dsh-interview/releases"><img alt="下载插件" src="https://img.shields.io/badge/GitHub_Releases-下载插件-202724?style=for-the-badge&logo=github"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-202724?style=for-the-badge"></a>
</p>
<p align="center">
  <a href="#安装">安装</a> · <a href="#开始使用">开始使用</a> · <a href="#实时语音面试">语音配置</a> · <a href="#常见问题">常见问题</a> · <a href="#从源码构建">开发</a>
</p>

**职镜AI** 是面向求职者的 DSH 原生插件。个人资料、目标岗位、原生聊天和模拟面试放在同一个工作台，文字分析直接使用 DSH 已配置的模型。

当前公开版本为 **0.1.0-dev.5 开发预览**，提供源码和可安装的 `.tgz`。npm 分发与 DSH 插件索引暂缓，请从本仓库 Release 安装。

## 可以做什么

### 一份资料，准备多个目标岗位

上传 PDF、DOCX、TXT 或图片，也可以粘贴文字、导入公开网页。先核对解析结果，再将确认过的简历和岗位材料用于分析。资料独立于岗位，更新简历会生成新版本，旧面试和报告继续引用当时的版本。

### 改简历，也说明修改依据

检查简历质量、分析岗位适配，生成完整改写稿并逐项选择采纳。判断需要引用资料，程序校验引用并计算分数；证据不足时明确说明。不会把模型建议自动当成真实经历，也没有分数解锁门槛。

### 从文字问答，到实时语音

每个目标岗位支持多个对话和多场面试。文字面试使用 DSH 模型；实时语音由专用音频模型主持，支持连续交谈、自动轮次、插话和字幕。结束后核对回答，再生成报告。

### 把准备过程带走

简历版本和面试报告可导出为 DOCX 或 PDF。工作台复用 DSH 原生聊天、模型选择、历史、流式回复和工具审批，随包提供 `zhijing-career` skill 与 `zhijing_*` 聊天工具。

## 安装

已验证宿主基线为 **DSH 0.2.2-rc.1**，需要 Node.js **24.9.0 或更新版本**及 `node:sqlite`。当前验证使用 Windows DSH Desktop，以及连接同一 Host 的 Chrome、Edge。其他宿主版本和平台尚未声明兼容。

1. 打开 [GitHub Releases](https://github.com/minhaoliu927-lgtm/dsh-interview/releases)，在 **Assets** 下载 `dsh-interview-0.1.0-dev.5.tgz`。
2. 在 DSH 插件管理中选择“添加插件”，将安装包的**绝对路径**填入“包名或地址”，点击“安装”。
3. 点击“立即启用”，从侧栏打开“职镜”。

GitHub 的 **Source code.zip / tar.gz** 是源码归档，不是插件安装包。首次安装外部依赖通常需要联网，但不需要 npm 账号。通过另一台电脑使用 DSH Web 时，`.tgz` 必须放在 **DSH Host 所在电脑**。

<details>
<summary><b>使用 CLI 安装到独立 profile</b></summary>

以下 `dsh` 指你明确选定的宿主 CLI。开发验收请使用独立源码与 `DSH_HOME`，避免影响日常环境。

```powershell
$env:DSH_HOME = Join-Path (Get-Location) '.runtime/zhijing/dsh'
dsh plugin --profile interview-test add ./dsh-interview-0.1.0-dev.5.tgz
dsh --profile interview-test --dump-config
```

按所选 DSH 应用的说明启动这个 profile 的 Desktop 或 Web 界面。插件注册 Host、Client、工具和 skill，本身不包含 Electron 外壳或另一份 DSH。CLI 详见 [DSH 插件发布说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/user/develop/basic/publish.zh.md)。

</details>

### 从旧名 dsh-zhijing 升级

`dsh-interview` 是新的包名和设置标识，中文品牌仍为“职镜AI”。

1. 结束当前任务，并记下旧插件的音频地域、业务空间、模型和启用状态。
2. 在官方插件管理中卸载 `dsh-zhijing`，然后安装并启用新包。**不要同时启用两个名称的插件。**
3. 在新插件的官方设置中重新保存上述音频选项。默认凭据引用仍为 `ZHIJING_REALTIME_API_KEY`；同一 DSH_HOME 中已有该凭据时，无需重填密钥。曾使用自定义引用的用户应在高级选项中保持原引用。

卸载保留资料；新版本继续使用同一 `DSH_HOME/zhijing` 数据目录、原生会话关联和工具名。设置属于新的包名，因此需要重新保存。备份时请先关闭相关 Host，再保存完整插件数据目录及所需 DSH 会话。

## 开始使用

1. 在 DSH 中选好文字模型。
2. 打开“个人资料”，导入简历、岗位描述和经历材料，核对正文并确认版本。
3. 新建“目标岗位”，关联已确认的资料。
4. 运行简历评分、岗位分析或改写；选择采纳内容后保存为新版本。
5. 新建文字或语音面试，选择中文或英文及题量。语音结束后集中核对转写，确认回答再生成报告。
6. 选择简历或报告，导出 DOCX/PDF。

工作台分析使用宿主默认文字模型；原生聊天中的工具使用当前会话选定的模型。模型不能代替你确认事实、OCR 结果或采纳修改。

## 实时语音面试

文字模型直接使用 DSH 的配置。实时语音需要支持双向音频的专用服务，当前接入 **阿里云百炼 Qwen-Omni-Realtime**。

在 **DSH 插件管理 → 职镜AI设置** 中：

1. 启用实时语音，选择北京或新加坡地域。
2. 填写你自己的百炼业务空间 ID，选择可用的实时音频模型。
3. 将该音频服务的 API Key 保存到 DSH 官方凭据服务。
4. 点击“测试音频 API”，通过后点击“播放测试语音”。

测试会实际生成一句短语音，显示连接和首音频耗时，最长等待 30 秒，可取消。它不会打开麦克风、读取简历或新建面试，返回的短音频仅在内存中保留，不自动播放。

开始面试后才申请麦克风权限。支持 16 kHz 单声道输入、24 kHz 输出，单次通话最长 30 分钟。暂停、结束、离开页面或网络故障会停止采集和播放；失败后可选择文字面试，不会自动重连或重发回答。

专用音频密钥由 DSH 保管，不写入插件业务数据库，不返回浏览器，也不复制文字模型密钥。当前只支持所选地域的官方端点。接口测试通过后，仍应在实际设备检查麦克风、字幕、听感和打断效果。

## 数据与隐私

- **本地资料**：业务记录、资料版本和导入原件位于所选 `DSH_HOME/zhijing`；原生聊天和凭据由 DSH 管理。停用取消任务，卸载保留资料。
- **模型请求**：分析时会把选定资料发送给 DSH 文字模型；实时面试会把本次冻结资料、已有转写和音频发送给所选音频服务。模型与音频服务可能产生费用。
- **语音记录**：不长期保存原始录音，保留供应商转写、用户修订和最终回答。报告仅使用确认过的回答，不把 AI 参考答案当作用户能力证据。
- **来源核对**：网页导入只读取公开 HTTP/HTTPS 内容，不使用浏览器登录状态。受限网页请自行完成验证，再上传截图；本地及私有网络地址会被拒绝。
- **文件限制**：单个文件最多 25 MiB。图片 OCR 需要 Windows Host 的已安装识别语言。扫描 PDF 或不足以提取的文字会提示截图 OCR 或粘贴原文。

本地存储不代表模型离线运行。当前没有逐条永久删除或完整备份恢复界面；请勿手工修改 SQLite 版本记录。请求失败时不会伪造分数或报告。

## 常见问题

<details>
<summary><b>在 DSH 搜索 dsh-interview 就能安装吗？</b></summary>

当前请从本仓库 Release 下载 `.tgz` 安装。npm 与插件索引尚未发布，GitHub 公开不代表已被 DSH 搜索收录，也不提供自动构建的 Git URL 安装方式。

</details>

<details>
<summary><b>为什么文字模型可用，语音仍需要配置？</b></summary>

文字模型未必支持实时音频。简历、评分和报告沿用 DSH 文字模型；实时通话使用单独的音频服务及其凭据。未配置时可继续使用文字面试。

</details>

<details>
<summary><b>语音测试通过，但通话没有声音或无法识别？</b></summary>

测试按钮验证接口连接及音频、文字输出，不采集麦克风。请检查设备、音量、浏览器权限及安全上下文（HTTPS 或 localhost），并确认配置已经保存。错误提示会区分配置、鉴权、权限、网络、限流和服务异常。

</details>

<details>
<summary><b>文字面试里的朗读和录音，与实时通话有什么区别？</b></summary>

文字面试还提供按轮录音和本地朗读。识别复用 DSH 官方语音服务，朗读使用设备本地声音，音质取决于系统；这不是实时音频模型。宿主未准备识别能力时，需要在官方“语音输入”设置中完成准备。录音最多 120 秒、WAV 最多 4 MiB，转写可编辑，确认后才提交。

</details>

<details>
<summary><b>与 DeepSeek 官方有什么关系？</b></summary>

这是社区开发的第三方插件，基于 DSH 公开扩展接口工作，不代表 DeepSeek 官方。DSH 由用户自行安装，第三方模型服务适用各自条款。

</details>

## 验证范围

开发固定宿主提交为 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。自动测试、真实模型和用户设备反馈分别记录，不把其中一项替代其余项目。

| 范围 | 已有验证 |
| --- | --- |
| Windows DSH Desktop | 插件安装、设置保存、工作台与文字模型；实际音频 API 返回语音和文字，项目使用者已反馈语音测试通过 |
| Chrome / Edge Web | 原生会话、流式回复、工具执行与历史一致性；实时音频前端有模拟设备回归 |
| 简历与报告 | 中英文合成资料的真实模型评分、岗位分析、改写、单题面试与报告；导出和引用校验有自动化测试 |
| 资料与生命周期 | 不可变版本、迁移、重启、取消、停用、卸载保留资料及安装包审计 |

本版仍为开发预览。完整多平台、多语言语音、权限拒绝、网络恢复和整场报告验收尚未全部覆盖；不声明所有 DSH 版本、设备或模型均兼容。

## 从源码构建

需要 Node.js 24.9.0+ 和 pnpm；验证使用 Node.js 24.19.0、pnpm 11.28.5。源码包含字体和材料解析模块，不依赖旧桌面工程。

```sh
git clone https://github.com/minhaoliu927-lgtm/dsh-interview.git
cd dsh-interview
pnpm install --frozen-lockfile
node scripts/fetch-font.mjs --verify-only
pnpm test
pnpm run build
node scripts/audit-package.mjs
pnpm pack --pack-destination ./release
```

构建需要允许 esbuild 的安装步骤。Windows 出现依赖硬链接错误时，可在独立目录安装时加 `--package-import-method=copy`。字体已随源码提供，正常构建不需要重新下载；安装插件包也无需本地编译。

| 目录 | 内容 |
| --- | --- |
| `client/` | 原生聊天嵌入、工作台、语音及官方设置界面 |
| `src/` | Host、业务存储、模型调用、材料解析与实时音频 |
| `skills/` | 随包求职 skill |
| `locale/` | 中文和英文文案 |
| `scripts/` | 构建、许可审计和白名单源码导出 |
| `test/` | 业务、生命周期与界面测试 |
| `assets/` | 自有标志和保留原许可的 Noto 字体 |

`scripts/prepare-source.mjs --out <新目录>` 可生成带 SHA-256 清单的干净源码；`--verify <目录>` 核对内容。安装包不包含原项目 Git 历史、运行数据、个人资料或密钥。公开代码不附带可用 API Key，请在自己的宿主中配置。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/minhaoliu927-lgtm/dsh-interview/issues) 提交问题或建议，说明 DSH 版本、平台、操作步骤和已脱敏的错误提示。请勿上传 API Key、完整个人简历、凭据文件或未经检查的日志。

## 许可与致谢

自有代码使用 [MIT](LICENSE)。第三方代码、依赖和字体保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：原生宿主与公开扩展接口。
- [dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk)：插件安装和宿主集成参考。
- [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go)：README 的内容组织参考；本仓库文案与品牌素材独立编写。
- [Noto CJK](https://github.com/notofonts/noto-cjk)：中文 PDF 字体，保留 SIL Open Font License 1.1。

<p align="center"><sub>职镜AI · dsh-interview · 用真实经历准备下一场面试。</sub></p>
