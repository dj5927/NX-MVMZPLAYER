import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.69.0').catch(reportFatal);

