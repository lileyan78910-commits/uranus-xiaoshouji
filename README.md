# Uranus 小手机 · 后端

让 AI 角色用 iMessage 跟你聊天。这是**后端**：一个跑在你自己 Cloudflare 账号上的
Worker，模型密钥、角色、聊天记录都存在这里，别人看不到。

控制台（网页界面）已经托管在 <控制台链接已加密，进审核群 1127727588，（三字社区搜Uranus小手机可以直接获得链接）>，你只需要部署这个后端，然后在控制台里连上它。

不用买服务器，不用一直开着电脑。Cloudflare 免费额度够一个人用。

**图文部署教程**：<https://ccnb9dqqjtkg.feishu.cn/docx/MPKbdvaYqoQEgKxKRUWccioBnyc?edition_id=B80Ihk>

**主仓库**（桌面版 Uranus iMessage，小手机的功能都来自它）：<https://github.com/nikonotnicotine/Uranus_Imessage>

> **声明：禁止倒卖**
>
> Uranus 小手机为免费项目。禁止出售、转卖 Uranus 小手机及 Uranus_Imessage 本体，以及账号密码、访问链接、密钥等相关内容。
>
> 禁止通过「代安装」「代注册」「整合包」等形式进行变相收费。
>
> 禁止未经允许二次分发，禁止套壳 / 二改售卖，禁止恶意破坏 / 攻击，禁止所有商业化。

---

## Uranus 小手机是什么

**让 AI 扮演一个人，用真的 iMessage 和你聊天。** 你在手机自带的「信息」App 里给一个号码发消息，
回你的是你自己设定的角色：有名字、有性格、记得你们聊过什么，会像真人一样一条条地回。

Uranus 本来是一个要在自己电脑上跑的程序（[Uranus iMessage](https://github.com/nikonotnicotine/Uranus_Imessage)），
电脑一关角色就下线。**小手机版**把它搬到了 Cloudflare 上：

- **不用电脑、不用服务器**：后端跑在你自己的 Cloudflare 免费账号里，24 小时在线。
- **手机上就能管**：控制台是个网页，手机浏览器打开就能改角色、看日志。
- **数据只在你自己那儿**：模型密钥、人设、聊天记录都存在你自己的 Worker 里，
  控制台只是个界面，我们看不到你的任何东西。

它**不提供** AI 模型和 iMessage 线路，这两样要你自己准备：

- **AI 模型**：OpenAI 格式的中转站、OpenAI / Gemini / Claude 官方接口都行，填 API 地址和密钥。
- **iMessage 线路**：用 [Photon](https://photon.codes) 注册一个项目，用你自己的手机号开通，拿到一条号码。

## 能做什么

**聊起来像真人**

- 一条回复拆成好几个气泡发，按字数算打字的停顿；你连发几条，它会等你说完再一起回
- 收到图片先看懂再回
- 已读、不回、撤回、贴 emoji 回应、气球烟花特效、链接卡片，都是 iMessage 原生的玩法
- 发**真的语音条**（Fish Audio / ElevenLabs），现画一张图发给你，按标签从图库里挑表情包
- 不知道的事先联网搜一下再回

**记得住事情**

- **记忆**：聊够一定轮数自动总结，之后聊到相关的事会想起来
- **备忘录**：谁的生日、约了什么，一份一直更新的清单
- **日记**：角色用第一人称写的日记，一直留着

**不只是发短信**

- **主动找你**：一阵子没人说话，角色会自己来找你；可以设勿扰时段
- **线下模式**：在网页里演一段剧情，能重 roll、能改、能自己改总结
- **多个角色**：一个角色绑一条号码，各自的人设、模型、记忆互不干扰

**配起来不难**

- 第一次打开会弹出**快速配置卡片**，一步一步问，填完就能聊
- 右下角的 **Uranus 助手**：找不到开关、看不懂报错，直接问它
- 预设、世界书、正则，玩过酒馆（SillyTavern）的会很熟悉
- 配置和聊天记录可以定时备份到缤纷云或 GitHub
- 手机上直接给角色发 `/help`，能看到清上下文、切模型、立刻出图这些指令

## 和桌面版的区别

小手机跑在 Cloudflare 上，有几样桌面版的东西用不了：

- 语音条只支持 **Fish Audio** 和 **ElevenLabs**（MiniMax、GPT-SoVITS 要 ffmpeg 转格式，Worker 里没有）
- 没有「重启服务」「检查更新」「整包备份 / 恢复」，更新方法见下面「以后怎么更新」
- 云备份不含图库里的图片，也不能从云备份直接恢复
- 控制台要先登录（账号一人一个，或者用 Discord 登录）

---

## 部署（一键）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nikonotnicotine/Uranus_Phone)

1. 点上面的按钮，用 GitHub 登录，再登录（或注册）Cloudflare。
2. 设置页上：
   - **URANUS_PASSWORD**：自己编一个后端密钥，至少 8 位、带一个大写字母。
     **记下来**，等会儿连控制台要用，部署完在后台只能改、看不到。
   - **TZ**：你所在的时区。国内填 `Asia/Shanghai`（默认就是）。
   - 其余保持默认。
3. 点 **Create and deploy**，等一两分钟构建完。
4. 部署完会显示后端地址，形如 `https://uranus-xiaoshouji.你的子域.workers.dev`。
   浏览器打开 `这个地址/api/health`，看到 `"ok":true` 就是好了。

## 连上控制台

1. 打开控制台网页：进审核群 1127727588（三字社区搜Uranus小手机可以直接获得链接）。
2. 先登录：用发给你的账号密码，或者用 Discord 登录（要先加入我们的服务器）。
   账号一人一个，别外借、别转卖，发现会停用。
3. **后端地址**填上一步的地址，**后端密钥**填你设的 `URANUS_PASSWORD`，点「连接」。
   这台浏览器记住了，下次打开直接进。
4. 在控制台里：
   - 「连接」：填模型的 API 密钥。
   - 「iMessage」：填 Photon 的 projectId / projectSecret，再填**你自己的手机号**
     （带国家码，比如 `+8613800138000`）去开通线路，拿到一个号码。
   - 「角色」：建个角色，绑上这个号码。
5. 用你的手机给那个号码发 iMessage，角色就会回你。

Photon 的项目凭据到 <https://photon.codes> 注册后在项目设置里拿。

## 常见问题

**忘了后端密钥 / 想换一个**
Cloudflare 后台 → Workers & Pages → 这个 Worker → Settings → Variables and Secrets，
把 `URANUS_PASSWORD` 改掉，点 Deploy。所有连着的浏览器会退回连接页，用新密钥重连。
配置和聊天记录不受影响。

**为什么要密钥**
Worker 地址是公开的。没有这一道，谁拿到地址都能读你的模型密钥和聊天记录。

**角色发语音**
小手机上发语音条要用 **Fish Audio** 或 **ElevenLabs**。MiniMax 和 GPT-SoVITS 在这里
发不成语音条（它们出的格式要 ffmpeg 转，Worker 里没有），会退回成文字。

**以后怎么更新**
一键部署会在你的 GitHub 下复制一份这个仓库。原仓库更新后，在你那份仓库页面点
**Sync fork**（或把新代码合进去），Cloudflare 会自动重新部署。数据都在 Durable Object 里，
更新不会丢。

---

## 手动部署（会用命令行的话）

```bash
git clone https://github.com/nikonotnicotine/Uranus_Phone.git
cd Uranus_Phone
npm install
npx wrangler login
npx wrangler secret put URANUS_PASSWORD
npx wrangler deploy
```

时区在 `wrangler.toml` 的 `[vars] TZ` 里改。

## 目录

- `src/`：Worker 入口，和把桌面版代码搬到 Worker 上用的替身（`src/shims/`）。
- `core/`：桌面版 Uranus 服务端代码的**生成副本**，别直接改。
