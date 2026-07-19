export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const KV = env.bt_KV;
    const ADMIN_USER = env.ADMIN_USER;
    const ADMIN_PASS = env.ADMIN_PASS;
    const LOGIN_TOKEN = "admin_login_ok_2026";
    const KV_DATA_KEY = "bt_list";
    const YEAR_SEC = 31536000;

    // ==================== 工具函数 ====================
    // 获取全部激活码数据
    async function getAllData() {
      const raw = await KV.get(KV_DATA_KEY);
      if (!raw) return [];
      return raw.split("\n").filter(l => l.trim() !== "");
    }
    // 保存全部数据到KV
    async function saveData(list) {
      await KV.put(KV_DATA_KEY, list.join("\n"));
    }
    // 获取登录Session
    function getSessionCookie() {
      const cookies = request.headers.get("Cookie") || "";
      const cookieMap = {};
      cookies.split("; ").forEach(item => {
        const [k, v] = item.split("=");
        cookieMap[k] = v;
      });
      return cookieMap;
    }
    // 设置登录Cookie
    function setLoginCookie() {
      return `admin_token=${LOGIN_TOKEN}; Max-Age=${YEAR_SEC}; Path=/; HttpOnly; SameSite=Lax`;
    }
    // 清空登录Cookie
    function clearLoginCookie() {
      return `admin_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
    }
    // 读取当前登录状态
    function isLogin() {
      const ck = getSessionCookie();
      return ck.admin_token === LOGIN_TOKEN;
    }
    // 跳转响应
    function redirect(location, cookie = "") {
      const headers = new Headers({ Location: location });
      if (cookie) headers.append("Set-Cookie", cookie);
      return new Response("", { status: 302, headers });
    }
    // 纯文本返回（API接口）
    function textRes(content) {
      return new Response(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    // HTML页面返回
    function htmlRes(html, setCookie = null) {
      const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (setCookie) headers.append("Set-Cookie", setCookie);
      return new Response(html, { headers });
    }

    // ==================== 路由1：激活验证API /?device_id=xxx&serial=xxx ====================
    if (url.searchParams.has("device_id") && url.searchParams.has("serial")) {
      const deviceId = url.searchParams.get("device_id").trim();
      const serial = url.searchParams.get("serial").trim();
      if (!deviceId || !serial) return textRes("off");

      const lines = await getAllData();
      let serialExists = false;
      let isActivated = false;
      let bindDeviceId = "";
      let targetIndex = -1;
      let note = "";

      for (let idx = 0; idx < lines.length; idx++) {
        const parts = lines[idx].split("|");
        const sn = parts[0] ?? "";
        if (sn === serial) {
          serialExists = true;
          targetIndex = idx;
          note = parts[4] ?? parts[1] ?? "";
          if (parts.length >= 4) {
            isActivated = true;
            bindDeviceId = parts[1]?.trim() ?? "";
          }
          break;
        }
      }

      if (!serialExists) return textRes("off");
      if (isActivated) {
        return bindDeviceId === deviceId ? textRes("on") : textRes("off-1");
      }

      // 未激活，绑定设备
      const now = new Date();
      const activateTime = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
      lines[targetIndex] = `${serial}|${deviceId}|${activateTime}|已激活|${note}`;
      await saveData(lines);
      return textRes("on");
    }

    // ==================== 路由2：退出登录 ?logout ====================
    if (url.searchParams.has("logout")) {
      return redirect("/", clearLoginCookie());
    }

    // ==================== POST表单处理（后台增删改逻辑） ====================
    let msg = "";
    let reqBody = null;
    if (request.method === "POST") {
      const formData = await request.formData();
      const lines = await getAllData();

      // 登录提交
      if (formData.has("login")) {
        const user = formData.get("user")?.trim() ?? "";
        const pass = formData.get("pass")?.trim() ?? "";
        if (user === ADMIN_USER && pass === ADMIN_PASS) {
          return redirect("/", setLoginCookie());
        } else {
          msg = "账号或密码错误";
        }
      }

      // 单个添加激活码
      if (formData.has("add_single")) {
        const sn = formData.get("serial")?.trim() ?? "";
        const exist = lines.some(l => l.split("|")[0] === sn);
        if (!exist) {
          lines.unshift(sn);
          await saveData(lines);
          msg = "添加成功";
        } else {
          msg = "已存在";
        }
      }

      // 批量添加
      if (formData.has("add_batch")) {
        const batchText = formData.get("batch") ?? "";
        const items = batchText.split("\n").map(i => i.trim()).filter(i => i);
        const existList = lines.map(l => l.split("|")[0]);
        const addList = items.filter(t => !existList.includes(t));
        if (addList.length > 0) {
          await saveData([...addList, ...lines]);
          msg = `批量添加成功：${addList.length} 条`;
        } else {
          msg = "无新数据";
        }
      }

      // 保存备注
      if (formData.has("save_note")) {
        const sn = formData.get("sn")?.trim() ?? "";
        let note = formData.get("note")?.trim() ?? "";
        note = note.replaceAll("|", " ");
        const newLines = [];
        for (const line of lines) {
          const arr = line.split("|");
          const id = arr[0] ?? "";
          if (id === sn) {
            if (arr.length >= 4) {
              newLines.push(`${arr[0]}|${arr[1]}|${arr[2]}|${arr[3]}|${note}`);
            } else {
              newLines.push(`${arr[0]}|${note}`);
            }
          } else {
            newLines.push(line);
          }
        }
        await saveData(newLines);
        msg = "备注已保存";
      }
    }

    // ==================== GET删除激活码 ?del_sn=xxx ====================
    if (url.searchParams.has("del_sn")) {
      const delSn = url.searchParams.get("del_sn").trim();
      const lines = await getAllData();
      const newLines = lines.filter(l => l.split("|")[0] !== delSn);
      await saveData(newLines);
      return redirect("/");
    }

    // ==================== 渲染页面HTML ====================
    const allLines = await getAllData();
    const loginStatus = isLogin();

    // 登录页HTML
    const loginHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>管理员登录</title>
<style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
        background: linear-gradient(135deg, #42a5f5, #4789d4);
        font-family:"Microsoft YaHei",sans-serif;
        display:flex;
        align-items:center;
        justify-content:center;
        min-height:100vh;
        padding:15px;
    }
    .login-box{
        background:#fff;
        width:100%;
        max-width:400px;
        padding:40px 30px;
        border-radius:16px;
        box-shadow:0 8px 30px rgba(0,0,0,0.15);
        animation: fadeIn 0.4s ease;
    }
    @keyframes fadeIn {
        from{opacity:0;transform:translateY(-20px);}
        to{opacity:1;transform:translateY(0);}
    }
    .login-box h2{
        text-align:center;
        margin-bottom:30px;
        color:#222;
        font-size:24px;
        font-weight:600;
    }
    .input-item{
        margin-bottom:20px;
    }
    .input-item label{
        display:block;
        margin-bottom:8px;
        color:#555;
        font-size:14px;
    }
    input{
        width:100%;
        padding:12px 15px;
        border:1px solid #e0e0e0;
        border-radius:8px;
        font-size:15px;
        transition:0.2s;
    }
    input:focus{
        outline:none;
        border-color:#42a5f5;
        box-shadow:0 0 0 3px rgba(66,165,245,0.15);
    }
    button{
        width:100%;
        padding:13px;
        background:#42a5f5;
        color:#fff;
        border:none;
        border-radius:8px;
        font-size:16px;
        font-weight:500;
        cursor:pointer;
        transition:0.2s;
        margin-top:10px;
    }
    button:hover{
        background:#3393e0;
    }
    .error{
        color:#f44336;
        text-align:center;
        margin-top:15px;
        font-size:13px;
    }
</style>
</head>
<body>
<div class="login-box">
    <h2>管理员登录</h2>
    <form method="post">
        <div class="input-item">
            <label>管理员账号</label>
            <input name="user" placeholder="请输入账号" required>
        </div>
        <div class="input-item">
            <label>登录密码</label>
            <input name="pass" type="password" placeholder="请输入密码" required>
        </div>
        <button name="login">安全登录</button>
        <div class="error">${msg}</div>
    </form>
</div>
</body>
</html>
`;

    // 未登录直接输出登录页
    if (!loginStatus) return htmlRes(loginHtml);

    // 后台管理页面HTML
    let tableRows = "";
    for (const line of allLines) {
      const arr = line.split("|");
      const sn = arr[0] ?? "";
      let device = "-", time = "-", status = "未激活", note = "";
      if (arr.length === 2) {
        note = arr[1];
      } else if (arr.length >= 4) {
        device = arr[1] ?? "-";
        time = arr[2] ?? "-";
        status = arr[3] ?? "未激活";
        note = arr[4] ?? "";
      }
      tableRows += `
        <tr>
            <td>${sn}</td>
            <td>${device}</td>
            <td>${time}</td>
            <td>${status}</td>
            <td>
                <form method="post" style="display:inline-flex;gap:4px;">
                    <input type="hidden" name="sn" value="${sn}">
                    <input type="text" name="note" value="${note}" style="width:100px;padding:4px;">
                    <button name="save_note" style="padding:4px 8px;">保存</button>
                </form>
            </td>
            <td><a href="?del_sn=${sn}" class="del-btn" onclick="return confirm('确定删除？')">删除</a></td>
        </tr>
      `;
    }
    if (allLines.length === 0) tableRows = `<tr><td colspan="6">暂无数据</td></tr>`;

    const adminHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>激活码管理系统</title>
<style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#f5f7fa;font-size:14px;font-family: "Microsoft YaHei", sans-serif;}
    
    .container{display:flex;min-height:100vh;position:relative;}
    @media (max-width:768px){
        .container{flex-direction:column;}
    }

    .sidebar{
        width:220px;
        background:#2c3e50;
        color:white;
        padding:15px 0;
        flex-shrink:0;
        transition:all 0.3s ease;
        position:relative;
    }
    .sidebar.collapsed{
        width:70px;
    }

    .sidebar-header {
        padding: 0 15px 12px;
        margin-bottom:12px;
        border-bottom:1px dashed #445;
        font-size:16px;
        white-space:nowrap;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .sidebar.collapsed .sidebar-header span.text{
        display:none;
    }
    .sidebar.collapsed .sidebar-header {
        justify-content: center;
        padding: 0 5px 12px;
    }

    .menu-item{
        padding:12px 15px;
        cursor:pointer;
        border-left:3px solid transparent;
        margin-bottom:4px;
        transition:0.2s;
        display:flex;
        align-items:center;
        gap:8px;
        white-space:nowrap;
    }
    .menu-item .icon{
        font-size:16px;
        width:20px;
        text-align:center;
    }
    .sidebar.collapsed .menu-item{
        justify-content:center;
        padding:12px 5px;
    }
    .sidebar.collapsed .menu-item .text{
        display:none;
    }
    .menu-item.active{background:#34495e;border-left:3px solid #3498db;color:#fff;}
    .menu-item:hover{background:#34495e;}
    
    @media (max-width:768px){
        .sidebar{width:100% !important;padding:10px 0 !important;}
        .sidebar-header {
            text-align:center;
            padding:0 10px 8px;
            margin-bottom:8px;
            font-size:16px;
            justify-content: center;
        }
        .sidebar.collapsed .sidebar-header span.text{display:inline;}
        .menu-item{
            display:inline-flex;
            border-left:none;
            border-bottom:3px solid transparent;
            margin:0 4px;
            padding:8px 10px;
            font-size:13px;
            justify-content:center;
        }
        .sidebar.collapsed .menu-item .text{display:inline;}
        .menu-item.active{border-left:none;border-bottom:3px solid #3498db;}
    }

    .logout-fixed {
        position: absolute;
        top: 15px;
        right: 20px;
        z-index: 999;
    }
    .logout-fixed a {
        display: inline-block;
        padding: 8px 12px;
        color: #ff6b6b;
        text-decoration: none;
        font-size: 14px;
    }
    @media (max-width:768px){
        .logout-fixed {
            top: 10px;
            right: 10px;
        }
        .logout-fixed a {
            font-size: 13px;
            padding: 6px 8px;
        }
    }

    .content{flex:1;padding:15px;transition:all 0.3s ease;}
    @media (max-width:768px){.content{padding:10px;}}
    .content-title{font-size:18px;margin-bottom:15px;color:#333;font-weight:bold;}
    .box{background:#fff;padding:15px;margin-bottom:15px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}
    .panel{display:none;}
    .panel.active{display:block;}

    input,textarea{padding:8px 10px;margin:6px 0;width:100%;max-width:380px;border:1px solid #ddd;border-radius:4px;}
    textarea{min-height:80px;resize:vertical;}
    button{padding:8px 16px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;margin:6px 4px;}
    .del-btn{background:#dc3545;padding:4px 10px;font-size:12px;color:#fff;text-decoration:none;}
    .green{background:#28a745;}

    .table-wrap{overflow-x:auto;width:100%;margin-top:10px;}
    table{border-collapse:collapse;width:100%;min-width:650px;white-space:nowrap;}
    td,th{border:1px solid #ddd;padding:8px;text-align:center;}
    th{background:#f8f9fa;}
    @media (max-width:768px){
        td,th{padding:6px 4px;font-size:12px;}
    }

    .msg{background:#d4edda;color:#155724;padding:8px 12px;border-radius:4px;margin-bottom:10px;}
    .tip{background:#f8f9fa;padding:10px;border-radius:4px;font-size:12px;color:#666;margin-top:10px;line-height:1.5;}
</style>
</head>
<body>

<div class="container">
    <div class="logout-fixed">
        <a href="?logout">🚪 退出登录</a>
    </div>

    <div class="sidebar" id="sidebar">
        <div class="sidebar-header" id="menuToggle">
            <span class="icon">☰</span>
            <span class="text">功能菜单</span>
        </div>
        
        <div class="menu-item active" onclick="showPanel('list')">
            <span class="icon">📋</span> <span class="text">激活码列表</span>
        </div>
        <div class="menu-item" onclick="showPanel('add')">
            <span class="icon">➕</span> <span class="text">单个添加</span>
        </div>
        <div class="menu-item" onclick="showPanel('batch')">
            <span class="icon">📄</span> <span class="text">批量添加</span>
        </div>
        <div class="menu-item" onclick="showPanel('api')">
            <span class="icon">📡</span> <span class="text">API说明</span>
        </div>
    </div>

    <div class="content">
        ${msg ? `<div class="msg">${msg}</div>` : ""}

        <div class="panel active" id="panel-list">
            <div class="content-title">📋 激活码列表</div>
            <div class="box">
                <div class="table-wrap">
                    <table>
                        <tr><th>序列号</th><th>设备ID</th><th>激活时间</th><th>状态</th><th>备注</th><th>操作</th></tr>
                        ${tableRows}
                    </table>
                </div>
            </div>
        </div>

        <div class="panel" id="panel-add">
            <div class="content-title">➕ 单个添加激活码</div>
            <div class="box">
                <form method="post">
                    激活码：<input name="serial" placeholder="请输入序列号" required>
                    <button name="add_single" class="green">确认添加</button>
                </form>
            </div>
        </div>

        <div class="panel" id="panel-batch">
            <div class="content-title">📄 批量添加激活码</div>
            <div class="box">
                <form method="post">
                    一行一个序列号：<br>
                    <textarea name="batch" placeholder="一行一个序列号"></textarea><br>
                    <button name="add_batch" class="green">批量导入</button>
                </form>
            </div>
        </div>

        <div class="panel" id="panel-api">
            <div class="content-title">📡 API 调用说明</div>
            <div class="box">
                <div class="tip">
                    调用示例：<br>
                    https://你的域名/?device_id=FD6987&serial=6666<br><br>
                    返回说明：<br>
                    on = 验证成功<br>
                    off = 无效序列号<br>
                    off-1 = 设备已绑定<br><br>
                    激活成功后自动写入：设备ID、激活时间、状态
                </div>
            </div>
        </div>
    </div>
</div>

<script>
const sidebar = document.getElementById('sidebar');
const menuToggle = document.getElementById('menuToggle');
document.addEventListener('DOMContentLoaded', function() {
    const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (collapsed) {
        sidebar.classList.add('collapsed');
    }
});
menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
});
function showPanel(name) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
    document.getElementById('panel-' + name).classList.add('active');
    document.querySelector(\`.menu-item[onclick="showPanel('\${name}')"]\`).classList.add('active');
}
</script>
</body>
</html>
`;
    return htmlRes(adminHtml);
  }
}
