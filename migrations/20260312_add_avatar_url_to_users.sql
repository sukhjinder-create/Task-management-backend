-- Migration: Add avatar_url to users table
-- Date: 2026-03-12

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
