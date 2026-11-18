APEXON 安装包上传目录
=========================

这个目录用来存放各 APP 的安装包（APK，以后也可以是其他类型的包）。
网站端（/apps.html）和手机 APP 端都会读取同目录下的 apps.json，从中获知
最新版本号、下载地址等信息。你只需要把包放进来、改一下 apps.json，两边就
会自动同步。

目录约定
--------
  apps/
    ├─ apps.json     ← 版本清单（网站与 APP 端都读这个文件）
    ├─ README.txt    ← 本说明
    └─ *.apk         ← 你上传的安装包，例如 apexon-weather-1.0.0.apk


一、上传一个应用（首次）
  1. 把安装包放进本目录，用英文名 + 版本号命名，避免空格和中文，例如：
       apexon-weather-1.0.0.apk
  2. 打开 apps.json，在 "apps" 数组里加上这个应用的一段（可参照里面的天气示例），
     至少填好：id、name、platform、icon、latest。
  3. 其中 latest.file 填安装包相对于站点根目录的路径，必须以 "apps/" 开头，
     例如 "apps/apexon-weather-1.0.0.apk"。
  4. 提交并推送到仓库，GitHub Pages 会自动发布。打开 /apps.html 就能看到它。

二、发布新版本（以后每次）
  1. 把新的安装包放进本目录，例如 apexon-weather-1.1.0.apk。
  2. 打开 apps.json，找到对应应用，把 "latest" 段整体改成新版本：
       version      显示给用户的版本号    例如 "1.1.0"
       versionCode  给 APP 比大小的整数    例如 2（每次必须比上一个大，不能相等或变小）
       date         发布日期              例如 "2026-11-01"
       size         安装包体积             例如 "13.2 MB"
       file         新安装包路径           例如 "apps/apexon-weather-1.1.0.apk"
       sha256       安装包 SHA-256 校验值  可选，建议填，APP 端可校验完整性
       changelog    更新说明，字符串数组，一行一条
  3. 把旧的 latest 内容整体挪进该应用的 "history" 数组存档，保持列表整洁。
  4. 提交推送即可，网站与 APP 端立刻可见。

  提示：更新 apps.json 顶部的 "updated" 字段为当前时间，有助于排查新旧。


三、APP 端如何检查更新（给 APP 开发对接用）
  APP 只需发一个 GET 请求：
       https://apexon.qzz.io/apps/apps.json

  然后：
    1. 在返回的 apps 数组里按 "id" 找到自己（天气 APP 的 id 是 "apexon-weather"）。
    2. 读取该条目的 latest.versionCode，与本地记录的版本号比较：
         本地 < 远程  →  有新版本，提示更新，并跳转下载。
         本地 >= 远程 →  已是最新。
    3. 安装包完整下载地址 = 站点域名 + "/" + latest.file
         例如 https://apexon.qzz.io/apps/apexon-weather-1.1.0.apk
    4. 若 latest.sha256 非空，下载后可校验文件完整性（可选）。

  注意：apps.json 请设置较短的缓存时间（或请求时加 ?t=时间戳 强制刷新），
  避免 APP 读到旧版本号。本目录下实例路径已经约定为 /apps/apps.json。


四、注意事项
  - file 路径一律以 "apps/" 开头（相对站点根目录），不要写完整域名。
  - 不要把签名文件（*.jks / *.keystore）、密钥、密码等放进本目录。
  - 单个安装包建议不超过 50MB。更大的包请改用对象存储（如 Cloudflare R2、
    GitHub Release 等），再把 file 字段换成对应直链即可。
  - apps.json 是纯文本 JSON，注意引号、逗号格式正确，改完可先在
    /apps.html 上刷新检查是否正常显示。
