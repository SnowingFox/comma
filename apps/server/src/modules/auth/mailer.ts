/** Sends the emails auth needs. `AuthModule` binds it to `ConsoleMailer` or `SMTPMailer` from `MAILER__DRIVER`. */
export abstract class Mailer {
  abstract sendVerificationCode(message: { to: string; name: string; code: string }): Promise<void>
}

export function verificationEmail(name: string, code: string): { subject: string; text: string } {
  return {
    subject: `${code} is your Comma verification code`,
    text: [
      `Hi ${name},`,
      '',
      `Your Comma verification code is ${code}. It expires in 10 minutes.`,
      '',
      'If you did not create a Comma account, you can ignore this email.'
    ].join('\n')
  }
}
