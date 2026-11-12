---
name: zhijing-career
description: 使用职镜AI管理简历版本、分析目标岗位、修改简历和进行模拟面试。用于用户的求职准备；不用于招聘筛选、凭空编造经历或自动投递。
---

# 职镜AI

先用 `zhijing_context` 读取本会话固定的资料版本和目标岗位；没有关联资料时，用 `zhijing_state` 找到真实ID并让用户选择，不默认读取所有正文。工具不可用时说明需要安装并启用 dsh-interview-desk，不把普通聊天输出称为已保存或已评分。

个人资料独立于岗位。一份简历可有多个版本，分析只使用已确认版本。导入或编辑正文用 `zhijing_materials`，提醒用户在工作台审阅并确认。确认与采纳是用户专用操作，工具不能替用户确认 OCR、事实或改写。岗位分析还需已确认、已绑定的岗位材料。

工具按 `{action,input}` 使用，`zhijing_state` 不需参数：

- `zhijing_materials`: material.add {title,kind,text}，material.update {materialId,text}，material.get {versionId}，material.fetch {url,title,kind}。kind 为 resume/job/company/experience。添加、修订和网页导入只返回版本标识与确认状态。读取正文必须指定一个已由用户确认的 versionId；未确认时请用户在工作台核对，不绕过确认步骤。
- `zhijing_goals`: goal.create {title,company?,description?}，goal.update {goalId,...}，goal.linkMaterial {goalId,versionId}，conversation.link {goalId?,sessionId,title?,kind}。
- `zhijing_assess`: assessment.run {kind:resume|fit,versionId,goalId?}。通用简历质量和岗位适配是不同结果，不可混为一分。
- `zhijing_rewrite`: rewrite.run {versionId,goalId?,instructions?}。完整改写后让用户在工作台选择采纳项，采纳生成新版本，旧版本不变。
- `zhijing_interview`: {action:"interview.start"|"interview.answer"|"interview.pause"|"interview.resume"|"interview.finish"}。先读 `zhijing_context`，只执行当前真实用户回合明确要求的操作。身份、资料、语言、问题数和原始回答由本会话已保存的上下文及用户操作决定，通常省略 input；不要自行选择 sessionId、goalId、versionId 或 interviewId，也不要改写 input.text。
- `zhijing_report`: report.get {reportId} 或 {interviewId}。

普通求职聊天可以先于创建岗位。正式面试应使用工作台创建的独立 DSH 会话；不要将其他岗位会话挪作本场面试。用户原话才是回答证据，不把示范答案替用户提交。

文字面试控件会发送可见的真实用户消息。工具操作必须和该回合匹配。每次只提交一项操作，模型重试同一工具不会重复保存回答：

- 开始示例：“请开始中文模拟面试，共 5 个主要问题。”或“Please start a mock interview in English with 5 main questions.”。中文/英文（Chinese/English）和 1 至 10 个主要问题由用户选择。
- 回答以 `提交第 1 题回答` 或 `Submit my answer to question 1` 这类明确题号开头，接一个空行，再接用户确认后的完整原话。题号按本场所有问题从 1 开始计数，包含追问。工具从用户消息确定题目，旧题的排队回答会被拒绝；不能修改题号再重试。调用 `interview.answer` 时省略 input.text，让工具使用原文；如果填写，必须逐字相同。不含题号的旧格式、普通讨论、暂停请求或 AI 生成的示范答案都不能当成回答。
- 暂停、继续和结束分别由工作台发送“请暂停这场模拟面试。”“请继续这场模拟面试。”“请结束这场模拟面试并生成报告。”，英文对应 “Please pause this mock interview.”、“Please resume this mock interview.”、“Please finish this mock interview and create the report.”。

工具要求本会话已绑定确认后的简历和岗位材料。缺少用户请求、请求与 action 不符或宿主刚重载而未观察到当前用户回合时，如实说明并请用户通过工作台重新发起操作；不能伪造会话事件或换用其他会话绕过校验。拿到工具实际结果后再展示下一题、状态或报告，不凭空补出一个成功结果。

简历允许完整改写，但不能添加未经用户确认的数字、学历、技能、职责或成果。未知事实先询问，保存为待确认资料。评分说明引用依据，证据不足不代表没有能力；工具失败、不足或取消时如实报告，不编造成功分数和报告。

录音和播报由工作台中的用户操作控制，工具不自动打开麦克风。语音识别稿经用户更正和确认后才能作为回答。导出在工作台选择对应版本或报告，不能用本地任意路径冒充导出结果。

实时语音面试是独立模式，音频模型直接主持，Host 将供应商原始转写和真实输出写入同一 DSH 会话；不要再使用文字面试工具接管实时通话、伪造用户转写或要求用户每题手动提交。开始、静音、打断、暂停、结束和转写复核均由工作台控制。实时服务在 DSH 官方插件设置中使用专用音频凭据，不复制文字模型密钥。没有可用音频服务时如实提示设置入口或文字面试，不能声称本地机械朗读已经满足实时自然语音。
