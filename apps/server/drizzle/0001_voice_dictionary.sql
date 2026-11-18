CREATE TABLE "dictionary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"term" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"mode" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"error_code" varchar(40),
	"delivery" varchar(16),
	"detected_language" varchar(16),
	"stt_retried" boolean DEFAULT false NOT NULL,
	"audio_seconds" double precision NOT NULL,
	"stt_ms" integer,
	"llm_ttft_ms" integer,
	"llm_total_ms" integer,
	"total_ms" integer,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"stt_cost_usd" double precision DEFAULT 0 NOT NULL,
	"raw_text" text,
	"refined_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dictionary_terms" ADD CONSTRAINT "dictionary_terms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_runs" ADD CONSTRAINT "voice_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_runs" ADD CONSTRAINT "voice_runs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dictionary_terms_user_term_idx" ON "dictionary_terms" USING btree ("user_id",lower("term"));--> statement-breakpoint
CREATE INDEX "dictionary_terms_user_idx" ON "dictionary_terms" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_runs_one_running_idx" ON "voice_runs" USING btree ("user_id") WHERE "voice_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "voice_runs_user_created_idx" ON "voice_runs" USING btree ("user_id","created_at");