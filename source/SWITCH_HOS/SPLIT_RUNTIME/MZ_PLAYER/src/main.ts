import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.46.0').catch(reportFatal);

