# codex-micro-bridge

[![CI](https://github.com/Hietan/codex-micro-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Hietan/codex-micro-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Hietan/codex-micro-bridge)](https://github.com/Hietan/codex-micro-bridge/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Current release: v0.1.0**

Codex Microの物理入力を，通常のキーボードショートカットではなくChatGPT Desktop内部のMicroイベントとして送る実験用CLIです．Codexが前面にない状態でも操作することを目的としています．

> [!WARNING]
> Codex MicroのrendererイベントとCDP接続は公開APIではありません．ChatGPT Desktopの更新で動作しなくなる可能性があります．このリポジトリは実験用です．

## 現在の範囲

- CDPの`app://.../index.html` rendererを検出
- Codex内部イベントバスを探索
- `codex-micro-device-state-changed`でMicro接続状態を初期化
- `codex-micro-hid-event`を送信
- `codex-micro-joystick-event`を送信
- Unix domain socket上のJSON Lines v1プロトコル
- ACT06〜ACT12，AG00〜AG05，ENC，ENC_CW，ENC_CC
- Codex Control QMK moduleのRaw HID入力（既定VID/PIDはhifumiの`FEED:3060`）
- 任意VID/PIDのQMKキーボード指定と切断後の自動再接続
- QMKからのAgent 6キー、Command 7スイッチ、Dial、Joystick全入力
- Codexの6 Agent状態を取得し、QMKへRaw HID output reportで同期
- Codexなしでクライアントを試せるmockモード

## 必要環境

- macOSまたはNode.jsからCDPポートを明示できる環境
- Node.js 22.4以降
- pnpm

## セットアップ

```bash
git clone https://github.com/Hietan/codex-micro-bridge.git
cd codex-micro-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

macOSの常駐CLIとしてソースからインストールする場合：

```bash
npm install --global .
codex-micro-bridge --version
```

v0.1.0ではGitHubへソースを公開します。npm registryへの公開有無はGitHub Releaseを
確認してください。registry未公開の場合も、上記のローカルインストールを利用できます。

## 1．安全なmockモードで確認

ターミナル1：

```bash
pnpm start -- --mock
```

ターミナル2：

```bash
node dist/src/cli.js status
node dist/src/cli.js tap ACT06
node dist/src/cli.js encoder cw
node dist/src/cli.js joystick up press
node dist/src/cli.js joystick up release
```

mockモードではイベントをログに出しますが，Codexには接続しません．

## 2．ChatGPT DesktopをCDP付きで起動

ChatGPTを完全に終了してから，macOSでは次のように起動します．既に起動しているChatGPTへ後からCDPフラグを追加することはできません．

```bash
open -a ChatGPT --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222
```

`9222`は実験用の例です．他ホストから到達できるアドレスにはbindしないでください．

接続確認：

```bash
node dist/src/cli.js probe --port 9222
```

Agent 6スロットの状態取得だけを診断するには次を使います。プロンプトや応答本文は
返さず、スロット番号、タスク識別子、状態、選択中フラグだけを表示します。

```bash
node dist/src/cli.js snapshot --port 9222
```

## 3．常駐Bridgeを起動

```bash
node dist/src/cli.js start --port 9222
```

ChatGPTがまだ準備できていない状態から待機させる場合は`--wait`を使います．

```bash
node dist/src/cli.js start --wait --port 9222
```

別ターミナルからFastキーをtapします．

```bash
node dist/src/cli.js tap ACT06
```

Bridgeはpressとreleaseを順に送ります．デフォルト設定ではACT06がFast Modeに対応しますが，実際の動作はCodex Micro設定の現在の割り当てに従います．

`start`はQMK Codex ControlのRaw HIDインターフェース（Usage Page `FF60`，Usage `61`）も自動検出します．既定USB IDはhifumiの`FEED:3060`です．接続済みなら起動時に次のように表示されます．

```text
Codex Control Raw HID connected (feed:3060, ..., usage ff60:0061).
```

キーボードが未接続でもBridgeは起動し，2秒間隔で再接続を試みます．Raw HIDを使用しない場合は`--no-hid`を付けます．

```bash
node dist/src/cli.js start --port 9222 --no-hid
```

別のQMKキーボードは16進VID/PIDで指定します．Usage Page/IDはモジュール既定値を
使用します．

```bash
node dist/src/cli.js start --port 9222 --hid-vid cafe --hid-pid 4001
```

hifumiファームウェアのキー割り当ては次のとおりです．

| hifumiキー | Raw HIDキー | 既定のCodex Micro動作 |
|---|---|---|
| Push-to-talk | `ACT10` | Push-to-talk |
| Codex | `ACT12` | Codex／送信 |
| Approve | `ACT07` | Approve |
| Fast | `ACT06` | Fast Mode |
| Dial左 | `ENC_CW` | 推論レベルを1段下げる方向 |
| Dial右 | `ENC_CC` | 推論レベルを1段上げる方向 |

実際の動作はCodex DesktopのCodex Micro設定にある現在の割り当てに従います．

Push-to-talkのように保持時間が必要な入力は分けて送ります．

```bash
node dist/src/cli.js press ACT10
node dist/src/cli.js release ACT10
```

Agentキーは物理スロットだけを送信します。Bridgeが押下時にCodex Micro設定の
現在の6スロットを読み、該当するタスク識別子を補完します。診断目的では従来どおり
明示的なタスク識別子も指定できます．

```bash
node dist/src/cli.js tap AG00
node dist/src/cli.js tap AG00 --thread-key '<task-id>'
```

Bridgeは750ms間隔でネイティブ6スロットを確認し、状態が変わったときだけ32-byte
output reportをキーボードへ返します。状態は未割当、待機、思考中、完了未読、
承認・入力待ち、エラーへ正規化されます。タスク識別子はUSB出力へ含めません。

## macOSでログイン時に自動起動

CLIをグローバルにインストールした後、LaunchAgentを登録できます。登録時点の
Node実行ファイルとCLIの絶対パス、CDPポート、USB IDがplistへ保存されます。

```bash
codex-micro-bridge service install --port 9222
codex-micro-bridge service status
```

ログイン時にChatGPTもloopback CDP付きでバックグラウンド起動する場合は明示的に
指定します。すでに開いているChatGPTを強制終了・再起動はしません。

```bash
codex-micro-bridge service install --port 9222 --launch-chatgpt
```

別キーボードの場合：

```bash
codex-micro-bridge service install --port 9222 --hid-vid cafe --hid-pid 4001
```

LaunchAgentはログイン時に起動し、ChatGPTが利用可能になるまで再試行し、QMK
キーボードは挿した時点で自動接続します。状態とログのフルパスは`service status`
が表示します。削除は次です。

```bash
codex-micro-bridge service uninstall
```

`--launch-chatgpt`を付けない場合、Bridgeの自動起動とChatGPTのCDP起動は別です。ChatGPT自体が
`--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222`付きで起動して
いなければ、LaunchAgentは安全に待機を続けます。CDPをLANへ公開しないでください。

## ポートの自動検出

macOSでは，ChatGPTのプロセス引数に次の両方が存在する場合，`--port`を省略できます．

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<port>
```

または環境変数を使用できます．

```bash
CODEX_MICRO_CDP_PORT=9222 node dist/src/cli.js start
```

## CLI

```text
start       常駐BridgeとQMK Raw HIDアダプターを起動
service     macOS LaunchAgentのinstall／uninstall／status
probe       Codex rendererとMicroハンドラーを確認
snapshot    Agent 6スロットのネイティブ状態取得を確認
status      常駐Bridgeの状態を確認
tap         キーのpress/releaseを送信
press       キーのpressを送信
release     キーのreleaseを送信
encoder     エンコーダーの1ステップを送信
joystick    ジョイスティックのpress/releaseを送信
send-json   JSON Lines v1メッセージを直接送信
```

詳細なプロトコルは[`docs/protocol.md`](docs/protocol.md)を参照してください．セキュリティ上の制約は[`SECURITY.md`](SECURITY.md)にまとめています．
全体構成と互換性方針は[`docs/architecture.md`](docs/architecture.md)を参照してください．

## 情報源と実装上の境界

OpenAIの公式ドキュメントは，AgentキーがChatGPTを前面に出さずにタスクを切り替えられること，Command Key・ダイヤル・ジョイスティックが設定可能であることを説明しています．一方，このCLIが利用するrendererイベント名とCDP経路は非公開です．

- [Codex Micro公式ドキュメント](https://learn.chatgpt.com/docs/features/codex-micro)
- [Codex Deckのrenderer bridge参照実装](https://github.com/dazer1234/codex-stream-deck/blob/main/src/codex-micro-renderer-bridge.ts)
- [Codex Deckのセキュリティ説明](https://github.com/dazer1234/codex-stream-deck/blob/main/SECURITY.md)

## リリース確認

```bash
pnpm install --frozen-lockfile
pnpm test
npm pack --dry-run
```

タグとnpm公開を行う場合はCI成功後に同じバージョンで行い、対応するQMKリリースと
Raw HID protocol versionをリリースノートへ記載します。npmへの公開はGitHubへの
ソース公開とは別の保守者操作です。

## 関連プロジェクト

- [Codex Control for QMK](https://github.com/Hietan/hifumi-codex-qmk)
- [Codex Micro Emulator](https://github.com/Hietan/codex-micro-emulator)

不具合報告は[Issueフォーム](https://github.com/Hietan/codex-micro-bridge/issues/new/choose)、
脆弱性はGitHubのprivate vulnerability reportingから報告してください。

## ライセンスと商標

BridgeはMIT Licenseです。状態探索の参照元は
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)に記載しています。本プロジェクトは
OpenAIの公式製品ではありません。OpenAI、Codex、ChatGPTおよび各商標はそれぞれの
権利者に帰属し、公式キーキャップ画像は同梱しません。
