CREATE TABLE "ingest_meta" (
	"format" text PRIMARY KEY NOT NULL,
	"last_success_at" bigint NOT NULL,
	"pokemon_count" integer NOT NULL,
	"learnset_count" integer NOT NULL,
	"names_count" integer NOT NULL,
	"schema_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learnset" (
	"pokemon_id" text NOT NULL,
	"move_slug" text NOT NULL,
	"format" text NOT NULL,
	"method" text,
	CONSTRAINT "learnset_pokemon_id_move_slug_format_pk" PRIMARY KEY("pokemon_id","move_slug","format")
);
--> statement-breakpoint
CREATE TABLE "pokemon" (
	"format" text NOT NULL,
	"id" text NOT NULL,
	"species_name" text NOT NULL,
	"form_name" text,
	"display_name" text NOT NULL,
	"national_dex_number" integer NOT NULL,
	"type1" text NOT NULL,
	"type2" text,
	"ability_slot1" text NOT NULL,
	"ability_slot2" text,
	"ability_hidden" text,
	"stat_hp" integer NOT NULL,
	"stat_attack" integer NOT NULL,
	"stat_defense" integer NOT NULL,
	"stat_special_attack" integer NOT NULL,
	"stat_special_defense" integer NOT NULL,
	"stat_speed" integer NOT NULL,
	"base_stat_total" integer NOT NULL,
	"sprite_url" text NOT NULL,
	"artwork_url" text NOT NULL,
	"generation" text NOT NULL,
	"is_gen9_native" integer NOT NULL,
	"source_generation" text,
	CONSTRAINT "pokemon_format_id_pk" PRIMARY KEY("format","id")
);
--> statement-breakpoint
CREATE TABLE "reference_cache" (
	"format" text NOT NULL,
	"resource_key" text NOT NULL,
	"resource_kind" text NOT NULL,
	"payload" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"fetched_at" bigint NOT NULL,
	CONSTRAINT "reference_cache_format_resource_key_pk" PRIMARY KEY("format","resource_key")
);
--> statement-breakpoint
CREATE TABLE "searchable_names" (
	"format" text NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	CONSTRAINT "searchable_names_format_kind_slug_pk" PRIMARY KEY("format","kind","slug")
);
--> statement-breakpoint
CREATE INDEX "learnset_move_slug_idx" ON "learnset" USING btree ("move_slug");--> statement-breakpoint
CREATE INDEX "learnset_pokemon_id_idx" ON "learnset" USING btree ("pokemon_id");--> statement-breakpoint
CREATE INDEX "pokemon_national_dex_number_idx" ON "pokemon" USING btree ("national_dex_number");--> statement-breakpoint
CREATE INDEX "pokemon_type1_idx" ON "pokemon" USING btree ("type1");--> statement-breakpoint
CREATE INDEX "pokemon_type2_idx" ON "pokemon" USING btree ("type2");--> statement-breakpoint
CREATE INDEX "pokemon_stat_hp_idx" ON "pokemon" USING btree ("stat_hp");--> statement-breakpoint
CREATE INDEX "pokemon_stat_attack_idx" ON "pokemon" USING btree ("stat_attack");--> statement-breakpoint
CREATE INDEX "pokemon_stat_defense_idx" ON "pokemon" USING btree ("stat_defense");--> statement-breakpoint
CREATE INDEX "pokemon_stat_special_attack_idx" ON "pokemon" USING btree ("stat_special_attack");--> statement-breakpoint
CREATE INDEX "pokemon_stat_special_defense_idx" ON "pokemon" USING btree ("stat_special_defense");--> statement-breakpoint
CREATE INDEX "pokemon_stat_speed_idx" ON "pokemon" USING btree ("stat_speed");--> statement-breakpoint
CREATE INDEX "pokemon_base_stat_total_idx" ON "pokemon" USING btree ("base_stat_total");