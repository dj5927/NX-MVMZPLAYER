import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.53.0').catch(reportFatal);

