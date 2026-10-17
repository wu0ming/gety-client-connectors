# 快速开始与发布范围

本仓库提供两个 GetY 连接器：DSH 连接器读取本地会话日志；WorkBuddy 连接器读取本地会话索引，并在有本地 trace 时补充部分对话正文。

## 快速开始

在 Windows 上，可以用 GetY 自带的 Deno 检查并构建两个连接器：

```powershell
$deno = "$env:LOCALAPPDATA\Gety\deno.exe"
Push-Location dsh\connector
& $deno task verify
Pop-Location
Push-Location workbuddy\connector
& $deno task verify
Pop-Location
```

DSH 用户可把 `dsh/plugin/` 安装为 DSH 插件，再从 **Plugins → GetY connector** 连接 GetY 并选择共享工作区。也可以在 GetY 的连接器设置中手动安装 DSH 连接器。

WorkBuddy 用户可以在 GetY 的连接器设置中手动安装连接器。仓库中的 `scripts/install-workbuddy.ps1` 用于从当前检出目录安装。

运行发布准备脚本会在仓库外生成三个运行时归档和校验和文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-release.ps1
```

默认输出到 `..\交付\gety-client-connectors\release-*\`；也可传入 `-OutputDirectory` 指定仓库外的输出目录。归档名为 `dsh-connector.zip`、`dsh-plugin.zip` 和 `workbuddy-connector.zip`，`SHA256SUMS.txt` 列出三个归档的 SHA-256 值。打包只包含明确列出的运行时文件和许可证，不包含本地运行记录、缓存、Git 元数据或真实会话数据。

## 当前验证范围

- DSH 和 WorkBuddy 的本地集成目前只在 Windows 环境验证过。CI 在 Linux 上执行 Deno 检查和构建；这不代表 GetY 或客户端集成已在 Linux、macOS 上验证。
- WorkBuddy 的完整对话正文在云端。只有桌面端写入本地 trace 的会话才包含正文；其余会话只提供本地元数据。
- 当前修正后的归档尚未安装到正在运行的 GetY 客户端。因此本次准备不声称归档已完成真实搜索、轮询或重启验证。
- CI 工作流定义了格式、lint、类型检查、单元测试、构建、DSH 插件语法与测试、内置连接器副本一致性和生成 bundle 新鲜度检查。每次发布应以对应提交的 GitHub Actions 结果及实际验证记录为准；本文件不预先标记 CI 状态。

## 源码仓库与发布

源码仓库：[wu0ming/gety-client-connectors](https://github.com/wu0ming/gety-client-connectors)。
下载源码后，从仓库根目录按上面的步骤安装或构建。DSH 与 WorkBuddy 分目录维护，可独立安装。

维护者上传审阅过的提交时，可执行：

```powershell
git push origin HEAD:main
```

每个归档都附带根目录 MIT `LICENSE`。DSH 归档及插件内置连接器还包含 `fzstd` 的 MIT 许可证文件。
