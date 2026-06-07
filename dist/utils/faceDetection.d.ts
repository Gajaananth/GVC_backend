export interface FaceValidationResult {
    valid: boolean;
    reason?: string;
}
export declare function validateFacePhoto(imageBuffer: Buffer): Promise<FaceValidationResult>;
export declare function hasFace(imageBuffer: Buffer): Promise<boolean>;
//# sourceMappingURL=faceDetection.d.ts.map