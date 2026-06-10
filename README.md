# Canvas Guy Limited — Production Order Tracker

Internal system for tracking orders, managing documents, and coordinating production across Canvas Guy and The Seating Company brands.

---

## 🚀 DEPLOYMENT GUIDE (Do these in order)

### Step 1: Create a Supabase project (5 min)
1. Go to **https://supabase.com** → Sign up (free)
2. Click **New Project** → name it `canvas-guy-tracker`
3. Choose a strong database password (save it somewhere!)
4. Select region closest to Kenya (e.g., `West EU` or `South Asia`)
5. Wait ~2 minutes for it to provision

### Step 2: Set up the database (2 min)
1. In Supabase dashboard → **SQL Editor** → **New Query**
2. Open the file `supabase/schema.sql` from this project
3. Copy-paste the ENTIRE contents into the SQL editor
4. Click **Run** — you should see "Success" for each statement

### Step 3: Create your first user (1 min)
1. In Supabase dashboard → **Authentication** → **Users**
2. Click **Add User** → **Create New User**
3. Enter your email + password → this is your admin login
4. Repeat for each team member who needs access

### Step 4: Get your API keys (1 min)
1. In Supabase dashboard → **Project Settings** (gear icon) → **API**
2. Copy the **Project URL** (looks like `https://xxxxx.supabase.co`)
3. Copy the **anon/public** key (the long string)

### Step 5: Create a GitHub repo (3 min)
1. Go to **https://github.com** → Sign up or log in
2. Click **New Repository** → name it `canvas-guy-tracker` → **Create**
3. On your computer, open Terminal and run:
```bash
cd canvas-guy-tracker
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/canvas-guy-tracker.git
git push -u origin main
```

### Step 6: Deploy on Vercel (3 min)
1. Go to **https://vercel.com** → Sign up with GitHub
2. Click **Add New Project** → Import your `canvas-guy-tracker` repo
3. Before deploying, add **Environment Variables**:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Project URL from Step 4
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon key from Step 4
4. Click **Deploy**
5. Wait ~1 minute — you'll get a live URL like `canvas-guy-tracker.vercel.app`

### Step 7: Log in and start using it
1. Open your Vercel URL
2. Sign in with the email/password you created in Step 3
3. Create your first real order!

---

## 📁 Project Structure

```
/app                     ← Pages and routing
  /login/page.js         ← Login screen
  /orders/page.js        ← Orders dashboard
/modules                 ← Feature modules (add new ones here)
  /orders/               ← Orders module
    config.js            ← Module metadata
    components/          ← UI components
  registry.js            ← Active modules list
/shared                  ← Shared utilities
  /supabase/             ← Database client
  /ui/                   ← App shell, sidebar
/supabase
  schema.sql             ← Database setup
```

## ➕ Adding a New Module

1. Create folder: `modules/your-module/`
2. Add `config.js` with name, icon, and nav items
3. Add `components/` with your UI
4. Add a page: `app/your-module/page.js`
5. Register it in `modules/registry.js`

---

Built with Next.js, Supabase, and Vercel.
