# Bacly Admin · déposer des sujets de partout (PWA)

Une petite app web qui s'installe sur le téléphone comme une vraie app.
Tu déposes un PDF ou tu photographies une épreuve ; le fichier attend dans un casier **privé** de Supabase ;
dès que le **serveur BacFlow du PC** est allumé, il le récupère, le lit (OCR), le classe (annales = 10 pages ou plus)
et le publie dans l'app Bacly.

## 1. Préparer Supabase (une seule fois, 5 minutes)
1. Ouvre **supabase.com** → ton projet (celui de Bacly).
2. **SQL Editor** → **New query** → colle tout le fichier `supabase-installation.sql`.
   Remplace `ton-email@exemple.com` par **ton e-mail**, puis **Run**.
   (Si tu n'as pas encore créé la table des demandes dans le serveur du PC, fais-le d'abord, puis relance ce script.)
3. **Authentication → Users → Add user → Create new user** : ton e-mail + un mot de passe solide, coche **Auto Confirm User**.
4. **Authentication → Sign In / Providers → Email** : décoche **Allow new users to sign up**
   (personne d'autre ne peut créer de compte ; de toute façon seul l'e-mail de la table `admins` peut déposer).

## 2. Mettre la PWA en ligne (gratuit)
Il faut une adresse **https** (obligatoire pour une PWA). Le plus simple :
1. Crée un compte gratuit sur **netlify.com**.
2. Va sur **app.netlify.com/drop** et **glisse le dossier `bacly-admin`** entier dans la page.
3. Netlify donne une adresse du type `https://xxxx.netlify.app` (tu peux la renommer : Site configuration → Change site name, ex. `bacly-admin.netlify.app`).
4. Pour une mise à jour : Netlify → ton site → **Deploys** → glisse à nouveau le dossier.

(Autre possibilité : GitHub Pages ou Cloudflare Pages ; tout marche, le dossier est 100 % statique.)

## 3. Installer sur le téléphone
- **Android (Chrome)** : ouvre l'adresse → connecte-toi → **Installer** (ou menu ⋮ → *Installer l'application*).
  Une fois installée, dans WhatsApp ou Fichiers : **Partager → Bacly Admin** envoie le PDF directement.
- **iPhone (Safari)** : Partager → **Sur l'écran d'accueil**.

## 4. Côté PC
Mets à jour le serveur BacFlow (fichiers `serveur.js` et `lib/depot.js`), avec la **clé secrète** déjà enregistrée
dans l'onglet *En ligne*. Toutes les 30 s, le PC :
- dit « je suis allumé » (le téléphone affiche *PC en ligne*) ;
- récupère les nouveaux dépôts, les range dans `Matière\Type` (ou `À classer`) et efface la copie en ligne ;
- met à jour l'état : *Au PC* → *Publié*, ou *À vérifier* si la matière n'est pas reconnue (tu peux alors **Classer** depuis le téléphone).

## Sécurité
- La page ne contient que la clé **publique** ; la clé secrète reste sur le PC.
- Le casier `depot` est privé et seul un compte dont l'e-mail est dans la table `admins` peut y déposer, lire les demandes et suivre les dépôts.
- Limites : PDF, JPG ou PNG, 50 Mo par fichier (offre gratuite).
