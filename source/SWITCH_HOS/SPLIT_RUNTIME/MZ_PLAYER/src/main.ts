import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.59.0').catch(reportFatal);

