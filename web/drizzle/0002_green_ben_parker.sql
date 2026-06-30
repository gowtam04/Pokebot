CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"pinned" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_message" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"text_content" text NOT NULL,
	"answer_json" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversation_account_updated_idx" ON "conversation" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_seq_idx" ON "conversation_message" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "message_account_idx" ON "conversation_message" USING btree ("account_id");