import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.51.0').catch(reportFatal);

