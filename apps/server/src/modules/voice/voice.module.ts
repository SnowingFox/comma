import { Logger, Module } from '@nestjs/common'
import { DictionaryModule } from '@/modules/dictionary/dictionary.module'
import { UsageModule } from '@/modules/usage/usage.module'
import { UserModule } from '@/modules/user/user.module'
import { LlmClient } from './providers/llm'
import { SttClient } from './providers/stt'
import { VoiceController } from './voice.controller'
import { VoiceRunStore } from './voice-run.store'
import { VoiceService } from './voice.service'

/** `POST /v1/voice/runs`: ElevenLabs speech to text and the LLM rewrite on Comma's credits. */
@Module({
  imports: [UserModule, DictionaryModule, UsageModule],
  controllers: [VoiceController],
  providers: [Logger, SttClient, LlmClient, VoiceRunStore, VoiceService]
})
export class VoiceModule {}
