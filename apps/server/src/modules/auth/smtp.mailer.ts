import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { createTransport, type Transporter } from 'nodemailer'
import { MailerConfig } from '@/app.config'
import { Mailer, verificationEmail } from './mailer'

/** Sends through the SMTP server in `MAILER__SMTP_URL` (`smtp://` with STARTTLS, or `smtps://`). */
@Injectable()
export class SMTPMailer extends Mailer implements OnModuleDestroy {
  @Inject()
  private readonly config: MailerConfig

  private transport?: Transporter

  async sendVerificationCode({ to, name, code }: { to: string; name: string; code: string }): Promise<void> {
    await this.getTransport().sendMail({ from: this.config.from, to, ...verificationEmail(name, code) })
  }

  onModuleDestroy(): void {
    this.transport?.close()
  }

  /** Created on first use, so the console driver never opens an SMTP connection. */
  private getTransport(): Transporter {
    if (!this.config.smtpUrl) {
      throw new Error('MAILER__SMTP_URL is not set')
    }
    this.transport ??= createTransport(this.config.smtpUrl)
    return this.transport
  }
}
