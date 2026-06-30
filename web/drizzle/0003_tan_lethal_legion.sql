CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"format" text NOT NULL,
	"name" text NOT NULL,
	"members" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "active_team_id" text;--> statement-breakpoint
CREATE INDEX "team_account_updated_idx" ON "team" USING btree ("account_id","updated_at");