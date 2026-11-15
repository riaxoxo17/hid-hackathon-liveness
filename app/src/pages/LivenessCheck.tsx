import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import { ThemeProvider } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

type Props = {
  sessionId: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (e: any) => void;
};

// Amazon Rekognition Face Liveness: the last step-up. Streams straight from the browser to AWS.
export default function LivenessCheck({ sessionId, region, credentials, onDone, onCancel, onError }: Props) {
  return (
    <ThemeProvider>
      <FaceLivenessDetectorCore
        sessionId={sessionId}
        region={region}
        disableStartScreen
        onAnalysisComplete={onDone}
        onUserCancel={onCancel}
        onError={onError}
        config={{ credentialProvider: async () => ({ ...credentials, expiration: new Date((credentials as any).expiration) }) }}
      />
    </ThemeProvider>
  );
}
