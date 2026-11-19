# Deployment

The frontend runs on Vercel. The Express API and private emotion scorer run as separate containers on the backend host. PostgreSQL remains an external managed database (the current schema and example setup target Neon).

## Docker deployment on an Oracle server

For a server where you can run Docker Compose, use the repository's `docker-compose.yml`; it builds and runs the backend and Python scorer together. Send your friend the repository and have them:

1. Install Docker Engine with the Docker Compose plugin and clone the repository.
2. Copy `.env.docker.example` to `.env.docker` and fill in the production database URL, provider credentials, a long random `EMOTION_SERVICE_TOKEN`, and the Vercel site origin for `CORS_ORIGIN`. Keep this file private.
3. Start the services with `docker compose --env-file .env.docker up --build -d`.
4. Apply the database schema once with `docker compose --env-file .env.docker run --rm backend npx prisma migrate deploy --schema prisma/schema.prisma`.
5. Route HTTPS traffic for the backend hostname to server port 8080 using a reverse proxy, and set Vercel's `VITE_API_URL` to that public HTTPS backend URL.

The emotion service is only exposed on Compose's internal network. The recordings are kept in a named Docker volume. The Python model downloads on first start, so allow time and outbound internet access. If your friend specifically needs to pull prebuilt images instead of building from the repository, they will need an image registry; these Dockerfiles and Compose config build the images on the server.

The Cloud Run definitions below are only for a GCP deployment.

## GCP services

1. Create a GCP project, enable billing, and enable Cloud Run and Cloud Build APIs. Create an Artifact Registry Docker repository named `callertone` in your chosen region.
2. Create a Cloud Storage bucket for recordings. Grant the backend Cloud Run service account permission to read and write objects in that bucket. The backend service definition mounts this bucket at `/mnt/audio`, so recordings remain available across container instances and restarts.
3. Create Secret Manager secrets named `DATABASE_URL`, `ELEVENLABS_API_KEY`, `GLM_BASE_URL`, `GLM_MODEL`, `GLM_API_KEY`, and `EMOTION_SERVICE_TOKEN`. Use the same random token value for the last secret in both services. Grant both service identities access only to the secrets they need; the backend needs all six, while emotion needs only the token.
4. Build and push both images from the repository root (replace `REGION` and `PROJECT_ID`):

   ```sh
   gcloud builds submit --region=REGION --tag REGION-docker.pkg.dev/PROJECT_ID/callertone/backend:latest --file backend/Dockerfile backend
   gcloud builds submit --region=REGION --tag REGION-docker.pkg.dev/PROJECT_ID/callertone/emotion:latest --file emotion-service/Dockerfile emotion-service
   ```

5. In `emotion-service/cloudrun.yaml`, replace the image region/project values. Deploy it with `gcloud run services replace emotion-service/cloudrun.yaml --region REGION --project PROJECT_ID`. Keep unauthenticated access disabled. The shared bearer token protects `/score`; `/health` is intentionally public for Cloud Run health checks.
6. In `backend/cloudrun.yaml`, replace the image region/project, `EMOTION_SERVICE_URL` with the emotion service URL, `YOUR_RECORDINGS_BUCKET`, and `YOUR_VERCEL_DOMAIN`. Deploy it with `gcloud run services replace backend/cloudrun.yaml --region REGION --project PROJECT_ID`. Keep unauthenticated access enabled for the browser API. Configure the bucket volume and Secret Manager permissions before starting the service.
7. Apply Prisma migrations once from a trusted machine or CI environment with the production `DATABASE_URL` set: `npm ci --prefix backend`, then `npm run db:migrate --prefix backend`. The migration command uses Prisma's development migration workflow; for a production migration job, use `npx prisma migrate deploy --schema backend/prisma/schema.prisma` from the repository root after installing backend dependencies.

The provided Cloud Run definitions use one request at a time per instance because the Python model is CPU-bound and the backend starts durable work in the request process. They set generous request timeouts for model loading and long recordings. Adjust instance limits and CPU/memory after measuring real workload and costs.

## Vercel frontend

Import the repository into Vercel and set the project Root Directory to `frontend`. The included `frontend/vercel.json` selects the TanStack Start framework and Nitro's Vercel output. Set `VITE_API_URL` in Vercel's Production and Preview environment variables to the public HTTPS URL of the Cloud Run backend (no trailing slash). The backend's `CORS_ORIGIN` should match the deployed Vercel origin; use the production domain for production and configure preview origins separately if you use preview deployments.

## Important runtime notes

- Cloud Run containers include FFmpeg. The emotion image downloads the emotion2vec assets from ModelScope while starting; allow outbound network access and budget for a large image and a cold start. Set the emotion service minimum instances to 1 if cold starts are too slow for your use case.
- The backend persists audio through a Cloud Storage FUSE mount. The service account needs bucket object read/write access. Keep the bucket in the same region where practical.
- This project starts analysis work in-process after returning `202`. A process interruption can stop active work; persisted database checkpoints allow the existing retry endpoint to resume failed jobs. For stronger delivery guarantees, move job execution to Cloud Tasks or a queue worker before high-volume production use.
- There is no user authentication in the current app. A public backend URL allows anyone to upload and inspect calls. Add authentication and authorization before using this with sensitive or customer recordings.
- Set `MAX_FILE_SIZE_BYTES`, `MAX_DURATION_SEC`, and `EXTERNAL_TIMEOUT_MS` on the backend as needed. Cloud Run request and memory limits also apply to 200 MB multipart uploads.
