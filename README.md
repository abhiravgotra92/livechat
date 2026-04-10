# 💬 LiveChat — Real-Time Chat, No Login Required

A real-time public chat app hosted on GitHub Pages.  
**No Firebase. No registration. No server. Nothing to configure.**

Powered by [Gun.js](https://gun.eco) — a decentralized real-time database.

---

## Features
- No login, no account, no registration anywhere
- Real-time messages across all users instantly
- Typing indicators
- Online user count
- Works on mobile and desktop
- Completely free forever

---

## Deploy to GitHub Pages (3 steps)

### Step 1 — Create a GitHub repo
1. Go to [github.com](https://github.com) → **New repository**
2. Name it anything (e.g. `livechat`)
3. Set it to **Public**
4. Click **Create repository**

### Step 2 — Push these files
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/livechat.git
git push -u origin main
```

### Step 3 — Enable GitHub Pages
1. Go to your repo → **Settings → Pages**
2. Under **Source** → select **GitHub Actions**
3. Wait ~1 minute for the workflow to run

Your chat is live at:
```
https://YOUR_USERNAME.github.io/livechat/
```

**Share that link with anyone — they just enter a name and start chatting.**

---

## Files
| File | Description |
|------|-------------|
| `index.html` | Chat UI |
| `style.css` | Dark theme |
| `chat.js` | Gun.js real-time logic |
| `.github/workflows/deploy.yml` | Auto-deploy to GitHub Pages |
