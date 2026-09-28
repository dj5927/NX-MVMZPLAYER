import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.50.0').catch(reportFatal);

