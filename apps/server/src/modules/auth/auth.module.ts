import { Logger, Module } from '@nestjs/common'
import { MailerConfig } from '@/app.config'
import { DeviceModule } from '@/modules/device/device.module'
import { UserModule } from '@/modules/user/user.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { ConsoleMailer } from './console.mailer'
import { EmailCodeService } from './email-code.service'
import { AccessTokenProvider } from './guards/access-token.provider'
import { Mailer } from './mailer'
import { SessionService } from './session.service'
import { SMTPMailer } from './smtp.mailer'

/** Register, verify email, login, refresh, logout, and the access-token provider the global guard runs. */
@Module({
  imports: [UserModule, DeviceModule],
  controllers: [AuthController],
  providers: [
    Logger,
    AuthService,
    EmailCodeService,
    SessionService,
    AccessTokenProvider,
    ConsoleMailer,
    SMTPMailer,
    {
      provide: Mailer,
      inject: [MailerConfig, ConsoleMailer, SMTPMailer],
      useFactory: (config: MailerConfig, console: ConsoleMailer, smtp: SMTPMailer): Mailer =>
        config.driver === 'smtp' ? smtp : console
    }
  ]
})
export class AuthModule {}
