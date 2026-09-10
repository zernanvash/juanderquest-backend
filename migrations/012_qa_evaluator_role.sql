-- Migration 012: Add QA Evaluator role to user_role enum
ALTER TYPE user_role ADD VALUE 'qa';
