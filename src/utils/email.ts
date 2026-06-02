import { Resend } from 'resend';
import { logger } from './logger';

export const sendEmail = async (to: string, subject: string, html: string, attachments: any[] = []): Promise<boolean> => {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.FROM_EMAIL || 'noreply@gvcagro.lk';
    
    if (!apiKey) {
      logger.warn('Resend API key missing. Cannot send email.');
      return false;
    }

    const resend = new Resend(apiKey);
    
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to,
      subject,
      html,
      attachments
    });

    if (error) {
      logger.error('Failed to send email:', error);
      return false;
    }

    logger.info(`Email sent successfully to ${to}`);
    return true;
  } catch (error) {
    logger.error('Error sending email:', error);
    return false;
  }
};
