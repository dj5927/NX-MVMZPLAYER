import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.56.0').catch(reportFatal);

