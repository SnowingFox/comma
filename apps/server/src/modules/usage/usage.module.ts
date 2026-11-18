import { Module } from '@nestjs/common'
import { UserModule } from '@/modules/user/user.module'
import { CreditsController, UsageController } from './usage.controller'
import { UsageService } from './usage.service'

@Module({
  imports: [UserModule],
  controllers: [UsageController, CreditsController],
  providers: [UsageService],
  exports: [UsageService]
})
export class UsageModule {}
