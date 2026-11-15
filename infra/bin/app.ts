#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KioskStack } from '../lib/kiosk-stack';

const app = new cdk.App();
new KioskStack(app, 'HidLivenessKiosk', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});
