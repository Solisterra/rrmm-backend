# Rocket Ranch Media Marketplace Backend

## API Endpoints

| Method(s) | Path | Description |
|---|---|---|
| GET | `/api` | API welcome message |
| GET, POST | `/api/auctions` | List auctions / create auction |
| GET, PATCH, DELETE | `/api/auctions/[id]` | Auction detail / update / cancel |
| POST | `/api/auctions/[id]/bid` | Place a bid |
| POST | `/api/uploads/presign` | Get signed upload URLs |
| GET | `/api/users` | Get authenticated user profile |
| POST | `/api/users/register` | Create user profile after auth signup |
| GET | `/api/users/earnings` | Photographer earnings summary and history |
| GET, POST, DELETE | `/api/watchlist` | Get/add/remove watchlist items |
| GET, PATCH | `/api/notifications` | List notifications / mark as read |
| GET, POST | `/api/stripe/connect` | Get onboarding link / create payment intent |
| POST | `/api/stripe/webhook` | Stripe webhook handler |
| GET, POST | `/api/admin/review` | List pending listings / approve or reject |
| GET | `/api/admin/dashboard` | Admin platform stats |
| GET | `/api/admin/attestations` | Admin attestation audit log |
| GET, POST | `/api/access/apply` | Submit buyer application / list applications (admin) |
| POST | `/api/access/review` | Review buyer application or send direct invite (admin) |
| GET | `/api/cron/close-auctions` | Close expired auctions (requires `Authorization: Bearer <CRON_SECRET>`) |
