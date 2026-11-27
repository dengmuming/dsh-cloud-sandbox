# dsh云端沙盒

本配方固定使用 `dsh-cloud-sandbox@0.2.3`，面向支持声明式 Agent Preset 的 DSH。它只提供 `bash` 执行工具，命令和工作文件处理都在 Linux Docker 容器中完成。子进程、Shell 执行器及命令工具共享一个独立的 Cordis 服务组。

## 使用前准备

1. 启动 Docker。Windows Docker Desktop 使用 Linux 容器模式；Linux / WSL2 启动对应 Docker Engine。
2. 安装插件依赖：`dsh plugin --profile desktop add dsh-cloud-sandbox@0.2.3`。Web 用户将 `desktop` 换成 `web`。
3. 在 DSH 插件管理器中关闭 `dsh-cloud-sandbox` 的 Profile 全局组合包开关，保留已安装的包。本配方直接加载其子模块；开启全局组合包会同时替换其他配方使用的执行器。
4. 按[插件说明](https://github.com/dengmuming/dsh-cloud-sandbox/blob/main/README.zh.md)从已安装包构建 `dsh-cloud-sandbox-runtime:latest` 镜像。导入配方不会安装 Docker、npm 依赖或镜像。
5. 通过 DSH Desktop 导入 `.dshpreset`，按应用提示重启，再新建会话，选择此配方及工作目录。工作目录需要已在 DSH 注册，或由启动进程的 `DSH_SANDBOX_ALLOWED_DIRS` 明确允许。

不要将本目录直接复制进 DSH 的 Preset 数据目录；使用 Desktop 的导入预览和安装流程。

## 行为与验证

配置已在独立的 DSH `0.2.2-rc.5` CLI 与 Docker 环境验证。其他 DSH 版本尚未验证；便携工具对 `.dshpreset` 的格式校验不等同于目标 Desktop 的导入预览和运行验证。

- 默认容器用户 `1000:1000`，只读根文件系统、默认断网，不挂载用户 Skill 目录或附件目录，不开放宿主文件导入及权限升级。
- 容器默认每个最多 2 CPU、128 PID，`/tmp` 为 256 MiB 有界临时空间；内存限额由插件运行池的默认值控制。
- `DSH_SANDBOX_IMAGE` 可以指定管理员准备的其他运行镜像。本配方不读取全局网络开关，保持 `networkMode: none`。
- 对话中先运行 `id -u`，应返回 `1000`；在所选目录中创建并读取测试文件。越界文件访问应失败。
- Docker 或镜像不可用时，执行失败，不会退回宿主执行。正常配方的执行器不由本配方修改。

本配方不加载独立的宿主文件工具，也不加载持久终端、后台任务或子代理。文件读取与修改使用容器内工具，避免 `0.2.3` 文件服务在多会话配方中按 Host 默认目录校验造成的兼容问题。

隔离范围限于本配方提供的 `bash` 命令工具。DSH 宿主、浏览器、MCP、其他插件及管理员另行启用的工具不在此声明内。配方本身是可执行配置，不是独立的安全边界。不要通过其他工具绕过这些限制。
