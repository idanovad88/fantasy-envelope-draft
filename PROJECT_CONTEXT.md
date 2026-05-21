# פנטזי דראפט מעטפות — Project Context

## תיאור הפרויקט
אפליקציית Web (PWA) לניהול דראפט אוקשן מעטפות סגורות לפנטזי NBA.
12 קבוצות, 13 שחקנים כל אחת, תקציב $200 לקבוצה.
כל שעתיים שחקן עולה למכרז — הצעות סגורות, נחשפות 30 דקות לפני המכרז הבא.

---

## Stack
- **Frontend + Backend:** Next.js 16 (App Router, TypeScript)
- **Database + Auth + Realtime:** Supabase (PostgreSQL + RLS)
- **Styling:** Tailwind CSS, RTL עברית, dark theme
- **Hosting:** Vercel (auto-deploy מ-GitHub)
- **Mobile:** PWA

---

## מיקום הפרויקט
```
C:\Users\idan\fantasy-draft-app
```

## GitHub
```
https://github.com/idanovad88/fantasy-envelope-draft
```

## Supabase Project
- **URL:** `https://jggbdsenfzoobgqmqhso.supabase.co`
- **Project ID:** `jggbdsenfzoobgqmqhso`
- **Region:** eu-west-1 (Ireland)

## Admin User
- **user_id:** `5dcaec63-89c7-456e-a482-aaff3d6082b9`
- **role:** superadmin
- נמצא בטבלת `admin_users`

---

## מבנה תיקיות
```
fantasy-draft-app/
├── app/
│   ├── (app)/                  # כל הדפים שדורשים התחברות
│   │   ├── layout.tsx          # בדיקת auth + Navbar
│   │   ├── page.tsx            # דאשבורד ראשי
│   │   ├── auction/page.tsx    # לוח מכרזים + הגשת הצעה
│   │   ├── players/page.tsx    # רשימת שחקנים
│   │   ├── teams/page.tsx      # כל הקבוצות + רוסטרים
│   │   ├── join/page.tsx       # הצטרפות לליגה עם קוד
│   │   ├── register-team/      # (ישן, הוחלף ע"י /join)
│   │   └── admin/
│   │       ├── page.tsx        # Server component — בדיקת admin
│   │       ├── AdminPanel.tsx  # Client component — כל לשוניות הניהול
│   │       └── ImportPlayers.tsx  # ייבוא שחקנים מ-CSV
│   ├── login/page.tsx          # דף התחברות
│   ├── api/
│   │   └── import-players/route.ts  # API לייבוא שחקנים
│   ├── layout.tsx              # Root layout (RTL, PWA metadata)
│   └── globals.css             # Design system (CSS variables, dark theme)
├── components/
│   ├── Navbar.tsx              # ניווט — desktop sidebar + mobile bottom nav
│   ├── BidForm.tsx             # טופס הגשת הצעה (עם חישוב מקסימום)
│   └── Countdown.tsx           # ספירה לאחור לחשיפה
├── hooks/
│   └── useRealtimeAuction.ts   # Supabase realtime subscription
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # Browser client
│   │   └── server.ts           # Server client + Admin client
│   └── utils.ts                # formatTime, getMaxBid, getCountdown
├── types/index.ts              # כל ה-TypeScript types
├── supabase/
│   ├── schema.sql              # סכמת DB מלאה + RLS + functions
│   └── migration_join_code.sql # Migration — הוסיף join_code לליגות
├── proxy.ts                    # Auth middleware (Next.js 16)
├── .env.local                  # מפתחות Supabase (לא ב-git)
└── public/manifest.json        # PWA manifest
```

---

## סכמת Database

### טבלאות
| טבלה | תיאור |
|------|--------|
| `leagues` | הגדרות ליגה (שם, קבוצות, שחקנים, תקציב, join_code, status) |
| `admin_users` | מנהלי מערכת (user_id, role: superadmin/admin) |
| `teams` | קבוצות (שם, תקציב, priority_rank, approved, is_complete) |
| `players` | שחקני NBA (שם, עמדה, קבוצה, ערך, סטטוס, stats JSONB) |
| `auctions` | מכרזים (player, nominating_team, scheduled_start, reveal_time, status) |
| `bids` | הצעות סגורות — RLS מגביל צפייה לפני reveal |
| `priority_log` | לוג שינויי פריוריטי |

### Supabase Functions
- `resolve_auction(p_auction_id)` — קובע מנצח, מטפל בשוויון ע"פ פריוריטי
- `refresh_team_stats(p_team_id)` — מחשב תקציב ומספר שחקנים
- `demote_priority(p_team_id, p_league_id)` — מוריד קבוצה לתחתית הפריוריטי
- `remove_complete_team_from_priority(...)` — מוציא קבוצה שסיימה

### RLS חשוב
- **bids** — הצעות נחשפות רק ל-owner שלהן OR אחרי `status IN ('revealed','completed')` OR admin
- **admin_users** — כל משתמש רואה רק את השורה שלו (`auth.uid() = user_id`)

---

## זרימת הדראפט
1. Admin נכנס ל-`/admin` → לשונית **הגדרות** → יוצר ליגה + מגדיר קוד הצטרפות
2. משתתפים נרשמים ב-`/join` עם הקוד → בוחרים שם קבוצה
3. Admin מאשר קבוצות בלשונית **קבוצות**
4. Admin מפעיל **הגרלת פריוריטי** → סדר רנדומלי נקבע
5. Admin מעלה שחקן ב-**מכרז** → בוחר שחקן + קבוצה מנומינייטור + זמן
6. משתתפים מגישים הצעות סגורות ב-`/auction` עד זמן החשיפה
7. Admin לוחץ **חשוף תוצאות** ואז **הסדר מכרז** → `resolve_auction()` רץ
8. קבוצה מנצחת מקבלת שחקן, תקציב מתעדכן

---

## לוגיקת מקסימום הצעה
```typescript
// lib/utils.ts
getMaxBid(budgetRemaining, playerCount, playersPerTeam)
// = budgetRemaining - (slotsLeft - 1)
// חובה לשמור $1 לכל slot פתוח
```

## לוגיקת שוויון
- שוויון → מנצח מי שיש לו **priority_rank** הכי נמוך
- אחרי זכייה בשוויון → הקבוצה יורדת לתחתית הפריוריטי
- קבוצה עם 13 שחקנים → יוצאת מטבלת הפריוריטי

---

## פקודות שימושיות

### הרצה מקומית
```bash
cd "C:\Users\idan\fantasy-draft-app"
npm run dev
# http://localhost:3000
```

### Deploy לאחר שינויים
```bash
cd "C:\Users\idan\fantasy-draft-app"
git add .
git commit -m "תיאור השינוי"
git push
# Vercel מ-deploy אוטומטי
```

### Build check לפני push
```bash
npm run build
```

---

## Migrations שעדיין צריך להריץ ב-Supabase SQL Editor

### join_code (אם לא הורץ עדיין)
```sql
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS join_code TEXT UNIQUE;
```

### תיקון RLS policy של admin_users (חובה!)
```sql
DROP POLICY IF EXISTS "admin_read" ON admin_users;
CREATE POLICY "admin_read" ON admin_users FOR SELECT USING (auth.uid() = user_id);
```

---

## בעיות ידועות / TODO
- [ ] Realtime — `useRealtimeAuction` hook קיים אבל לא מחובר לדפים (דפים עושים server-side refresh)
- [ ] אין email notifications כשמכרז נפתח/נחשף
- [ ] אין הגנה מפני הגשת הצעה גבוהה מהתקציב בצד ה-server (רק client-side validation)
- [ ] `/register-team` עדיין קיים אבל הוחלף ע"י `/join` — ניתן למחוק
- [ ] ייבוא שחקנים — ניתן לייבא גם ישירות מ-Excel (להוסיף בעתיד)

---

## Design System
```css
/* CSS Variables — globals.css */
--background: #0f1117
--card: #1a1d27
--border: #2a2d3a
--primary: #6366f1   /* indigo */
--success: #22c55e
--warning: #f59e0b
--danger: #ef4444
--text: #f1f5f9
--muted: #64748b
```

Classes: `.card`, `.btn`, `.btn-primary`, `.btn-success`, `.btn-danger`, `.btn-outline`, `.input`, `.badge`, `.badge-green/yellow/red/blue/gray`
