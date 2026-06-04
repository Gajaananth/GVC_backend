"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = void 0;
const resend_1 = require("resend");
const logger_1 = require("./logger");
const sendEmail = async (to, subject, html, attachments = []) => {
    try {
        const apiKey = process.env.RESEND_API_KEY;
        const fromEmail = process.env.FROM_EMAIL || 'noreply@gvcagro.lk';
        if (!apiKey) {
            logger_1.logger.warn('Resend API key missing. Cannot send email.');
            return false;
        }
        const resend = new resend_1.Resend(apiKey);
        const { data, error } = await resend.emails.send({
            from: fromEmail,
            to,
            subject,
            html,
            attachments
        });
        if (error) {
            logger_1.logger.error('Failed to send email:', error);
            return false;
        }
        logger_1.logger.info(`Email sent successfully to ${to}`);
        return true;
    }
    catch (error) {
        logger_1.logger.error('Error sending email:', error);
        return false;
    }
};
exports.sendEmail = sendEmail;
//# sourceMappingURL=email.js.map