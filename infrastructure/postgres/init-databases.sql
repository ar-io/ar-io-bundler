-- Initialize both payment_service and upload_service databases
-- This script runs when PostgreSQL container first starts

-- Create payment_service database
CREATE DATABASE payment_service;

-- Create upload_service database
CREATE DATABASE upload_service;

-- Grant privileges (user is created by POSTGRES_USER env var)
GRANT ALL PRIVILEGES ON DATABASE payment_service TO turbo_admin;
GRANT ALL PRIVILEGES ON DATABASE upload_service TO turbo_admin;

-- Enable pg_stat_statements per database for slow/hot query observability.
-- Requires shared_preload_libraries=pg_stat_statements (set in the postgres
-- command in docker-compose.yml). This runs ONLY on a fresh data volume; on an
-- existing volume, run the same CREATE EXTENSION manually after restarting with
-- the preload library enabled (see runbook §17).
\connect payment_service
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
\connect upload_service
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\echo 'Databases created: payment_service, upload_service (pg_stat_statements enabled)'
