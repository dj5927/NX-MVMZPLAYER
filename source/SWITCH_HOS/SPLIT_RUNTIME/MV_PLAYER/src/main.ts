import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.64.0').catch(reportFatal);

