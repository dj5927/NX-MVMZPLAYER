import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.67.0').catch(reportFatal);

