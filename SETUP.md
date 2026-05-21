# Fantasy Draft App — הוראות התקנה

## 1. הגדרת Supabase

1. פתח את [supabase.com](https://supabase.com) והכנס לחשבון שלך
2. צור project חדש
3. עבור ל-**SQL Editor** ורוץ את כל הקוד מקובץ `supabase/schema.sql`
4. עבור ל-**Settings → API** ועתיק:
   - `Project URL`
   - `anon public` key
   - `service_role` key (secret!)

## 2. הגדרת Environment Variables

צור קובץ `.env.local` בתיקיית הפרויקט:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

## 3. יצירת Admin User

1. עבור ל-**Supabase → Authentication → Users** → Invite User (או Create User)
2. צור את המשתמש שלך עם אימייל וסיסמה
3. עבור ל-**SQL Editor** ורוץ:
```sql
-- החלף עם ה-user_id שלך מ-Authentication
INSERT INTO admin_users (user_id, role)
VALUES ('your-user-uuid-here', 'superadmin');
```

## 4. הרצה מקומית

```bash
cd fantasy-draft-app
npm run dev
```
פתח `http://localhost:3000`

## 5. העלאה ל-Vercel

```bash
npm install -g vercel
vercel
```
הגדר את 3 ה-env vars ב-Vercel dashboard.

## 6. ייבוא שחקנים

כנס כ-Admin → לחץ על הלינק לייבוא שחקנים → הדבק CSV בפורמט:
```
name,team,pos,rank,value,ppg,rpg,apg
Nikola Jokic,DEN,C,1,85,26.4,12.4,9.0
Shai Gilgeous-Alexander,OKC,G,2,78,30.1,5.5,6.4
```

## זרימת הדראפט

1. Admin יוצר ליגה → קובע הגדרות
2. שחקנים נרשמים דרך `/register-team`
3. Admin מאשר קבוצות
4. Admin מפעיל הגרלת פריוריטי
5. דראפט מתחיל — Admin מעלה שחקן מדי 2 שעות
6. משתתפים מגישים הצעות סגורות
7. Admin חושף תוצאות ומסדיר מכרז
