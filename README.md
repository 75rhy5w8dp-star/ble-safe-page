# COCO / SVAKOM Bluefy relay

一个由云端服务转发命令、由 iPhone Bluefy 连接 BLE 设备的中转页。

## 支持设备

- COCO：FF60 服务、FF61 写入特征；吮吸和舌舔震动各 0–20 档；支持两路 20/20 暴走与全停。
- SVAKOM SL278H：FFE0 服务、FFE1 写入特征；保留 0–100% 强度控制。
- 页面不会访问 AE00 / AE01 固件通道。

## Render 配置（推荐）

仓库根目录带有 `render.yaml`。在 Render 中选择 **New → Blueprint** 并连接本仓库，平台会创建免费 Web Service，并自动生成 `BRIDGE_SECRET`。

部署后在 Render 服务的 **Environment** 页面查看 `BRIDGE_SECRET`，并在 Bluefy 页面填写：

```text
https://你的服务名.onrender.com
```

MCP 地址为：

```text
https://你的服务名.onrender.com/mcp?secret=你的BRIDGE_SECRET
```

## 其他 Node 托管平台

必须设置环境变量 `BRIDGE_SECRET`。建议使用至少 24 位随机字符串。

MCP 地址：

```text
https://你的域名/mcp?secret=你的BRIDGE_SECRET
```

Bluefy 页面填写相同的云端根地址和 `BRIDGE_SECRET`，连接玩具后点“连接中转”。

## MCP 工具

- `toy_status`
- `toy_set_suction`：COCO 吮吸 0–20
- `toy_set_vibration`：COCO 舌舔震动 0–20
- `toy_rampage`：COCO 两路 20/20
- `toy_stop`：全停
- `toy_set_speed`：旧 SVAKOM 强度 0–100%

控制指令默认只保留 30 秒，Bluefy 页面离开前台时会尝试立即停止。

## 验证

```bash
npm test
```
