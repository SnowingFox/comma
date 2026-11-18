import { Inject, Injectable, Logger } from '@nestjs/common'
import { MailerConfig } from '@/app.config'
import { Mailer } from './mailer'

/** Development mailer: logs that a message was sent, and the code only with `MAILER__DEV_PRINT_CODES=1`. */
@Injectable()
export class ConsoleMailer extends Mailer {
  @Inject()
  private readonly config: MailerConfig

  @Inject()
  private readonly logger: Logger

  async sendVerificationCode({ to, code }: { to: string; name: string; code: string }): Promise<void> {
    const detail = this.config.devPrintCodes ? `: ${code}` : ' (set MAILER__DEV_PRINT_CODES=1 to print it)'
    this.logger.log(`verification code for ${to}${detail}`, ConsoleMailer.name)
  }
}
